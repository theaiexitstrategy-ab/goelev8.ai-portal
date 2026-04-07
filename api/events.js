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
    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal_error' });
  }
}

export const config = { api: { bodyParser: false } };
