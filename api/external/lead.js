// (c) 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cross-origin lead-capture endpoint for external sites posting into
// the portal's CRM (`public.leads`). Sister to /api/external/funnel-
// subscribe — same bearer-token pattern, but keyed by client_api_keys
// (per-client) instead of funnel_api_keys (per-AI-funnel), and writes
// to the leads table with dedupe via findOrUpsertLead.
//
// Used by: willpowerfitnessfactory.com /api/lead (server-to-server).
// Auth: Authorization: Bearer <raw key>. Raw key is shown once at issue
// time; only the sha256 hash is stored in client_api_keys.key_hash.
//
// Accepts both the legacy WPFF payload shape (first_name + last_name +
// goal) and the canonical portal shape (name + intent + notes), so the
// caller doesn't have to reshape before posting.

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

  const payload = {
    name,
    phone,
    email,
    source: body.source ? strip(body.source, 50) : 'web_form',
    funnel: body.funnel ? strip(body.funnel, 50) : (body.gym ? strip(body.gym, 50) : null),
    status: body.status ? strip(body.status, 30) : 'New',
    intent: body.intent ? strip(body.intent, 50) : null,
    notes: body.goal ? strip(body.goal, 500) : (body.notes ? strip(body.notes, 500) : null),
    tags,
  };

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
