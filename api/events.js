// Cross-project event ingestion + portal listing.
//
// ?action=ingest  -> POST from The-AI-Exit-Strategy Supabase project
//                    (Database Webhook) or directly from client websites.
//                    Authenticated by HMAC SHA-256 over the raw body using
//                    the INGEST_WEBHOOK_SECRET env var.
//                    Header: X-GoElev8-Signature: sha256=<hex>
//                    Body: {
//                      client_slug?: 'flex-facility' | 'islay-studios' | ...
//                      client_domain?: 'theflexfacility.com' | ...
//                      source: 'theflexfacility.com',
//                      source_path?: '/fit',
//                      event_type: 'form_submission' | 'booking' | 'lead' | ...,
//                      external_id?: 'upstream-row-id',
//                      contact_email?, contact_phone?, contact_name?, title?,
//                      payload: { ...arbitrary fields... },
//                      occurred_at?: ISO timestamp
//                    }
//
// ?action=list    -> GET, JWT-authenticated portal call. Returns latest
//                    client_events for the caller's client.
//
// ?action=vapi    -> POST from Vapi webhooks. Authenticated by shared secret
//                    in the x-vapi-secret header (env VAPI_WEBHOOK_SECRET).
//                    Handles call.started (upserts a Vapi lead) and
//                    call.ended (inserts a vapi_calls row). Resolves the
//                    client_id from existing leads.phone, falling back to
//                    DEFAULT_CLIENT_ID env var.
//
// ?action=lead    -> POST from a client website (form submit) or the
//                    /embed/track.js script. Authenticated by shared
//                    secret in the x-goelev8-secret header
//                    (env GOELEV8_WEBHOOK_SECRET).
//                    Body: { slug, name, phone?, email?, source?,
//                            funnel?, metadata? }
//                    Resolves client_id from slug, auto-tags from source/
//                    funnel/URL hints, inserts into leads. Rate-limited
//                    to 100 requests/minute per slug. Vercel rewrite
//                    exposes this at the friendlier
//                    POST /api/webhooks/lead URL.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireUser, methodGuard, readJson } from '../lib/auth.js';
import { sendWelcomeForEvent } from '../lib/welcome.js';

// Map known client website hostnames to client slugs.
const DOMAIN_TO_SLUG = {
  'theflexfacility.com': 'flex-facility',
  'www.theflexfacility.com': 'flex-facility',
  'islaystudiosllc.com': 'islay-studios',
  'www.islaystudiosllc.com': 'islay-studios'
};

function readRaw(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'string') return resolve(req.body);
    if (req.body && typeof req.body === 'object') return resolve(JSON.stringify(req.body));
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function timingSafeEq(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function verifySignature(raw, header) {
  const secret = process.env.INGEST_WEBHOOK_SECRET;
  if (!secret) throw new Error('missing_INGEST_WEBHOOK_SECRET');
  if (!header) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeEq(provided, expected);
}

async function resolveClientId(body) {
  if (body.client_id) return body.client_id;
  let slug = body.client_slug;
  if (!slug && body.client_domain) {
    const host = String(body.client_domain).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    slug = DOMAIN_TO_SLUG[host];
  }
  if (!slug && body.source) {
    const host = String(body.source).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    slug = DOMAIN_TO_SLUG[host];
  }
  if (!slug) return null;
  const { data } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  return data?.id || null;
}

async function handleIngest(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const raw = await readRaw(req);
  const sig = req.headers['x-goelev8-signature'] || req.headers['x-goelev8-signature'.toLowerCase()];
  let ok;
  try { ok = verifySignature(raw, sig); }
  catch (e) { return res.status(500).json({ error: e.message }); }
  if (!ok) return res.status(401).json({ error: 'invalid_signature' });

  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const clientId = await resolveClientId(body);
  if (!clientId) return res.status(422).json({ error: 'unknown_client' });

  if (!body.event_type) return res.status(400).json({ error: 'missing_event_type' });
  if (!body.source) return res.status(400).json({ error: 'missing_source' });

  const row = {
    client_id: clientId,
    source: String(body.source),
    source_path: body.source_path || null,
    event_type: String(body.event_type),
    external_id: body.external_id || null,
    contact_email: body.contact_email || null,
    contact_phone: body.contact_phone || null,
    contact_name: body.contact_name || null,
    title: body.title || null,
    payload: body.payload || {},
    occurred_at: body.occurred_at ? new Date(body.occurred_at).toISOString() : new Date().toISOString()
  };

  // Idempotent insert: ignoreDuplicates so a re-fired webhook doesn't
  // re-trigger the welcome SMS. If external_id is null we can't dedupe,
  // so we always insert a new row.
  const { data, error } = await supabaseAdmin
    .from('client_events')
    .upsert(row, { onConflict: 'client_id,source,external_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });

  const isNew = !!data?.id;
  let welcome = { sent: false, reason: 'duplicate_event' };

  if (isNew) {
    // Load full client (need balance, twilio creds, template) and try welcome.
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('*')
      .eq('id', clientId)
      .single();
    if (client) {
      try { welcome = await sendWelcomeForEvent({ client, event: row }); }
      catch (e) { welcome = { sent: false, reason: 'exception: ' + (e.message || e) }; }
    }
  }

  return res.status(200).json({ ok: true, id: data?.id || null, is_new: isNew, welcome });
}

// ============================================================
// Universal lead webhook (POST /api/webhooks/lead via Vercel
// rewrite, also reachable as ?action=lead). Auto-tags by source
// URL, inserts into leads, fans out via Supabase Realtime so
// open browsers fire a notification.
// ============================================================

// Friendly source -> tag mapping. Anything not matched falls back
// to "general". Used ONLY when the caller didn't explicitly send
// body.tags / body.tag — explicit client tags always win.
function ge8AutoTag({ source, funnel, metadata }) {
  const tags = new Set();
  const candidate = [source, funnel, metadata?.url, metadata?.path]
    .filter(Boolean).join(' ').toLowerCase();
  if (/\/fit(\b|\/)/.test(candidate))     tags.add('athlete');
  if (/\/rs2(\b|\/)/.test(candidate))     tags.add('lifestyle');
  if (/(^|\/|\.)book\./.test(candidate))  tags.add('ready-to-book');
  if (/\/book(ing)?(\b|\/)/.test(candidate)) tags.add('ready-to-book');
  if (/sms|twilio/.test(candidate))       tags.add('sms-lead');
  if (!tags.size) tags.add('general');
  return [...tags];
}

// Normalize the caller-provided tag shape into a text[] for the leads
// table. Accepts all of:
//   body.tags: "athlete"           → ['athlete']
//   body.tags: ["athlete","vip"]   → ['athlete','vip']
//   body.tags: "athlete, vip"      → ['athlete','vip']
//   body.tag:  "athlete"           → ['athlete']   (legacy singular)
// Returns null if neither field is present or both are empty — caller
// then falls back to ge8AutoTag() so we never overwrite an explicit
// tag with an auto-generated fallback.
function ge8NormalizeTags(body) {
  const raw = body.tags ?? body.tag;
  if (raw == null || raw === '') return null;
  let arr;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    // Support comma-separated ("athlete, vip") and JSON-encoded
    // (`["athlete","vip"]`) string forms, since different client
    // sites have sent both shapes in the wild.
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try { arr = JSON.parse(trimmed); } catch { arr = [trimmed]; }
    } else {
      arr = trimmed.split(',');
    }
  } else {
    arr = [String(raw)];
  }
  const cleaned = (Array.isArray(arr) ? arr : [arr])
    .map((t) => (t == null ? '' : String(t).trim().toLowerCase()))
    .filter(Boolean);
  return cleaned.length ? cleaned : null;
}

// In-memory rate limiter: 100 requests / 60 seconds per slug.
// Vercel functions can run on multiple instances so this is best-
// effort, not a hard cap. Sufficient to throttle a runaway form.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 100;
const ge8LeadRate = new Map();
function ge8RateLimitOk(slug) {
  const now = Date.now();
  const key = String(slug || '__unknown__');
  const arr = ge8LeadRate.get(key) || [];
  const recent = arr.filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) {
    ge8LeadRate.set(key, recent);
    return false;
  }
  recent.push(now);
  ge8LeadRate.set(key, recent);
  return true;
}

async function handleLead(req, res) {
  // CORS — this endpoint is called from arbitrary client websites
  // (the embed/track.js form-capture beacon, or hand-rolled fetch
  // from a /fit funnel page, etc.). The custom X-GoElev8-Secret
  // header makes every cross-origin POST a "non-simple" request,
  // which means the browser fires an OPTIONS preflight first. We
  // accept any origin because the secret is what proves the call
  // is legit — browser origin alone wouldn't help anyway.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GoElev8-Secret, x-goelev8-secret');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const expected = process.env.GOELEV8_WEBHOOK_SECRET;
  if (!expected) return res.status(500).json({ error: 'webhook_secret_not_configured' });

  // Parse the body first so we can also accept the secret in the body
  // when sendBeacon (which can't set custom headers) is used by the
  // /embed/track.js fallback path.
  let body;
  try {
    const raw = await readRaw(req);
    body = raw ? JSON.parse(raw) : {};
  } catch { return res.status(400).json({ error: 'invalid_json' }); }

  const headerSecret =
    req.headers['x-goelev8-secret'] ||
    req.headers['X-GoElev8-Secret'.toLowerCase()];
  const provided = headerSecret || body.secret;
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });
  // Strip the body secret before we touch any other field so it never
  // accidentally lands in metadata or logs.
  delete body.secret;

  const slug = String(body.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'missing_slug' });

  if (!ge8RateLimitOk(slug)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'rate_limited' });
  }

  const { name, phone, email, source, funnel, metadata } = body;
  if (!name && !phone && !email) {
    return res.status(400).json({ error: 'missing_contact_info' });
  }

  // Look up the client by slug.
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client)   return res.status(404).json({ error: 'unknown_slug' });

  // Explicit caller-provided tags always win over URL auto-tagging. This
  // fixes the regression where every lead from theflexfacility.com/fit
  // landed as tags=['general'] even though the proxy sent tag='athlete'.
  // Only fall back to ge8AutoTag() when both body.tags and body.tag are
  // missing, so a quiet client site still gets a sensible default.
  const tags = ge8NormalizeTags(body) || ge8AutoTag({ source, funnel, metadata });

  const insertRow = {
    client_id: client.id,
    name: (name || phone || email || 'Unknown').toString().slice(0, 200),
    phone: phone ? String(phone).slice(0, 32) : null,
    email: email ? String(email).slice(0, 200) : null,
    source: source ? String(source).slice(0, 200) : null,
    funnel: funnel ? String(funnel).slice(0, 64) : null,
    status: 'New',
    tags,
    created_at: new Date().toISOString()
  };

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('leads')
    .insert(insertRow)
    .select('id')
    .single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  // The portal browser already subscribes to postgres_changes on
  // public.leads filtered by client_id (see startRealtime in app.js),
  // so an INSERT here automatically fans out a "New lead: …" system
  // notification + toast to every connected client tab. No extra
  // server-side push fan-out needed.

  return res.status(200).json({
    ok: true,
    lead_id: inserted?.id,
    client_id: client.id,
    tags,
    notification: {
      title: 'New Lead',
      body: `${insertRow.name} just came in${source ? ' from ' + source : ''}`,
      url: '/?view=dashboard'
    }
  });
}

// ============================================================
// Vapi webhook receiver (folded in here to stay under the
// Vercel 12-function cap).
// ============================================================
const VAPI_OUTCOME_MAP = {
  customerHangup: 'Hung Up',
  assistantHangup: 'Completed',
  voicemail: 'Voicemail'
};

async function resolveVapiClientId(phone) {
  if (phone) {
    const { data } = await supabaseAdmin
      .from('leads')
      .select('client_id')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.client_id) return data.client_id;
  }
  return process.env.DEFAULT_CLIENT_ID || null;
}

async function handleVapi(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return res.status(500).json({ error: 'webhook_secret_not_configured' });
  if (req.headers['x-vapi-secret'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const raw = await readRaw(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  // Vapi sometimes nests the event under `message` — accept both shapes.
  const evt = body?.message || body || {};
  const type = evt.type || body?.type;
  const call = evt.call || body?.call;
  if (!type || !call) return res.status(400).json({ error: 'missing_type_or_call' });

  const phone = call.customer?.number || null;
  const clientId = await resolveVapiClientId(phone);
  if (!clientId) return res.status(400).json({ error: 'no_client_resolved' });

  if (type === 'call.started') {
    if (phone) {
      const { data: existing } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('client_id', clientId)
        .eq('phone', phone)
        .maybeSingle();
      if (!existing) {
        const { error } = await supabaseAdmin.from('leads').insert({
          client_id: clientId,
          name: phone,
          phone,
          source: 'Vapi',
          status: 'Contacted',
          created_at: new Date().toISOString()
        });
        if (error) return res.status(500).json({ error: error.message });
      }
    }
    return res.status(200).json({ ok: true, handled: 'call.started' });
  }

  if (type === 'call.ended') {
    const outcome = VAPI_OUTCOME_MAP[call.endedReason] || call.endedReason || null;
    const { error } = await supabaseAdmin.from('vapi_calls').insert({
      client_id: clientId,
      caller_phone: phone,
      duration_seconds: Number(call.duration) || 0,
      outcome,
      transcript: call.transcript || null,
      vapi_call_id: call.id || null,
      created_at: new Date().toISOString()
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, handled: 'call.ended' });
  }

  return res.status(200).json({ ok: true, ignored: type });
}

async function handleList(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const type = url.searchParams.get('type');
  let q = ctx.sb
    .from('client_events')
    .select('id, source, source_path, event_type, contact_email, contact_phone, contact_name, title, payload, occurred_at')
    .order('occurred_at', { ascending: false })
    .limit(limit);
  if (type) q = q.eq('event_type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ events: data || [] });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');
  try {
    if (action === 'ingest') return await handleIngest(req, res);
    if (action === 'list')   return await handleList(req, res);
    if (action === 'vapi')   return await handleVapi(req, res);
    if (action === 'lead')   return await handleLead(req, res);
    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal_error' });
  }
}

export const config = { api: { bodyParser: false } };
