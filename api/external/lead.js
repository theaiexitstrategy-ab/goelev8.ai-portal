// (c) 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cross-origin lead-capture endpoint for external sites posting into
// the portal's CRM (`public.leads`). Sister to /api/external/funnel-
// subscribe — same bearer-token pattern, but keyed by client_api_keys
// (per-client) instead of funnel_api_keys (per-AI-funnel), and writes
// to the leads table with dedupe via findOrUpsertLead.
//
// Used by: theaiexitstrategy.com /api/leads (server-to-server).
// willpowerfitnessfactory.com /api/lead was the original caller and its
// payload shape is still supported below, but its key was revoked
// 2026-06-04 and WPFF's leads now arrive via /api/events?action=ingest
// (HMAC) instead — so the legacy branch here is compatibility, not a
// live path. Re-issue a key if that ever flips back.
// Auth: Authorization: Bearer <raw key>. Raw key is shown once at issue
// time (scripts/issue-client-api-key.mjs); only the sha256 hash is
// stored in client_api_keys.key_hash.
//
// Accepts both the legacy WPFF payload shape (first_name + last_name +
// goal) and the canonical portal shape (name + intent + notes), so the
// caller doesn't have to reshape before posting.
//
// ---- Structured extras -------------------------------------------
// Callers may send a `metadata` object (alias: `payload`) carrying the
// facts the deliberately lean leads table has no column for. It lands
// in leads.payload (jsonb, migration 0030); one level of scalars or
// arrays of scalars, anything deeper is dropped.
//
// The customer-profile drawer renders these keys as a definition list,
// in this order, mapping enum values to their labels:
//
//   org_name           free text
//   org_type           k12 | higher_ed | nonprofit | workforce |
//                      library | faith | other
//   role               free text
//   group_size         under_15 | 15_40 | 40_100 | over_100 | unsure
//   timeline           asap | this_quarter | six_months | exploring
//   how_heard          search | social | referral | event | other
//   goal               job_search | business_income | keep_up | curious
//   newsletter_opt_in  boolean
//   sms_consent        boolean
//   source_path        free text
//   message            free text, rendered as a pull quote
//
// Unrecognised keys are stored but not rendered; an unrecognised enum
// value renders as its raw slug rather than disappearing. `timeline`
// also drives the urgency badge and the "most urgent first" sort on the
// leads table, which reads the `timeline:<value>` tag when a row has no
// payload.
//
// `notes` stays the fallback and is NOT deprecated: senders write both,
// rows predating this only have notes, and the profile drawer parses
// the labelled "Label: value" notes block when no payload is present.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { methodGuard, readJson } from '../../lib/auth.js';
import { findOrUpsertLead } from '../../lib/lead-dedupe.js';

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function strip(v, max = 200) {
  return String(v).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

// `notes` carries the human-readable summary an external site builds for
// the operator. theaiexitstrategy.com's partner block is ~300 chars of
// labelled facts plus up to 4000 chars of the enquirer's own words, so
// the old 500-char ceiling silently truncated the part that matters
// most. Keep a ceiling (this is unauthenticated-adjacent input) but put
// it above what any current sender produces.
const NOTES_MAX = 8000;

// Structured extras (`metadata` / `payload`). Deliberately shallow: one
// level of scalars, plus arrays of scalars. Anything deeper is a sign
// the caller should be posting to /api/events instead, and letting
// arbitrary nesting through would make the profile renderer's job
// unbounded. Caps are belt-and-braces against a caller with a bug.
const META_MAX_KEYS = 40;
const META_MAX_STRING = 4000;
const META_MAX_BYTES = 32 * 1024;

function metaScalar(v) {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return strip(v, META_MAX_STRING);
  return undefined; // objects/functions/undefined -> dropped
}

function sanitizeMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Object.keys(out).length >= META_MAX_KEYS) break;
    const key = String(k).replace(/[^\w.:-]/g, '').slice(0, 60);
    if (!key) continue;
    if (Array.isArray(v)) {
      const arr = v.map(metaScalar).filter((x) => x !== undefined).slice(0, 40);
      if (arr.length) out[key] = arr;
      continue;
    }
    const scalar = metaScalar(v);
    if (scalar !== undefined && scalar !== '') out[key] = scalar;
  }
  if (!Object.keys(out).length) return null;
  // Hard size gate so one oversized field can't bloat every row read.
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > META_MAX_BYTES) return null;
  return out;
}

// Permissive CORS — the caller is a server-side proxy (WPFF /api/lead),
// not the browser, so this is defense-in-depth only. The bearer-token
// check is the real gate.
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });
  const rawKey = m[1].trim();
  if (!rawKey) return res.status(401).json({ error: 'Missing bearer token' });

  const keyHash = hashKey(rawKey);

  const { data: keyRow, error: keyErr } = await supabaseAdmin
    .from('client_api_keys')
    .select('id, client_id, revoked_at, scopes')
    .eq('key_hash', keyHash)
    .single();

  if (keyErr || !keyRow || keyRow.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked key' });
  }
  if (Array.isArray(keyRow.scopes) && !keyRow.scopes.includes('leads:write')) {
    return res.status(403).json({ error: 'Key lacks leads:write scope' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Accept both shapes. `name` wins if present; otherwise stitch from
  // first_name + last_name. Either email or phone is required (lead-
  // dedupe needs at least one matching key).
  const name =
    body.name
      ? strip(body.name)
      : [body.first_name, body.last_name]
          .map((s) => (s ? strip(s, 100) : '')).filter(Boolean).join(' ')
          .trim() || null;

  const email = body.email
    ? strip(String(body.email).toLowerCase(), 200)
    : null;
  const phone = body.phone ? strip(body.phone, 32) : null;

  if (!email && !phone) {
    return res.status(400).json({ error: 'email or phone required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  // Lead-dedupe payload. `goal` from WPFF maps to `notes` (free-text
  // context the operator sees in the CRM); we DON'T overload `intent`
  // because intent is a structured enum-ish field in the portal UI.
  const tags = [];
  if (body.partial_capture === true || body.partial_capture === 'true') tags.push('partial_capture');
  if (Array.isArray(body.tags)) tags.push(...body.tags.map((t) => strip(t, 40)).filter(Boolean));

  // Same ceiling the CRM's PATCH handler enforces, so a tag list that
  // arrives here can always be round-tripped through the tag editor.
  const cleanTags = [...new Set(tags)].slice(0, 20);

  // `metadata` is the documented name; `payload` is accepted as an alias
  // because that's what the column is called and what /api/events sends.
  const metadata = sanitizeMetadata(body.metadata) || sanitizeMetadata(body.payload);

  const payload = {
    name,
    phone,
    email,
    source: body.source ? strip(body.source, 50) : 'web_form',
    funnel: body.funnel ? strip(body.funnel, 50) : (body.gym ? strip(body.gym, 50) : null),
    status: body.status ? strip(body.status, 30) : 'New',
    intent: body.intent ? strip(body.intent, 50) : null,
    notes: body.goal ? strip(body.goal, NOTES_MAX) : (body.notes ? strip(body.notes, NOTES_MAX) : null),
    page_url: body.page_url ? strip(body.page_url, 500) : null,
    tags: cleanTags,
  };
  if (metadata) payload.payload = metadata;

  let result;
  try {
    result = await findOrUpsertLead(keyRow.client_id, payload);
  } catch (err) {
    console.error('[external/lead] findOrUpsertLead error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Fire-and-forget last_used_at update on the key. Don't gate the
  // response on this — it's audit metadata, not correctness.
  supabaseAdmin
    .from('client_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', keyRow.id)
    .then(() => {})
    .catch(() => {});

  return res.status(result.created ? 201 : 200).json({
    ok: true,
    lead_id: result.id,
    created: result.created,
  });
}
