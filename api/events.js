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
// ?action=vapi    -> POST from Vapi server webhook. Public URL is rewritten
//                    by vercel.json from /api/webhooks/vapi to this action.
//                    Authenticated by a shared secret in the
//                    `x-vapi-secret` header (env: VAPI_WEBHOOK_SECRET).
//                    Handles `end-of-call-report`, `status-update`, and
//                    `function-call` messages and writes vapi_calls / leads
//                    / bookings rows for the matching tenant.

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

// ============================================================
// Vapi webhook
// ============================================================
//
// Vapi posts a JSON body of the shape:
//   { message: { type, call: { id, assistantId, phoneNumberId, customer: { number } },
//                transcript, summary, recordingUrl, durationSeconds,
//                cost, endedReason, analysis: { structuredData, summary }, ... } }
//
// We resolve the tenant by matching `call.phoneNumberId`, the assistant id,
// or the customer number against `clients.twilio_phone_number`. Each call is
// upserted on `vapi_call_id` so retries are idempotent. When the upstream
// reports an end-of-call we also write a `leads` row (and optionally a
// `bookings` row if the structured data carries booking fields).
async function resolveVapiClientId({ phoneNumberId, assistantId, toNumber, fromNumber, customerNumber }) {
  const tryNumbers = [toNumber, fromNumber, customerNumber].filter(Boolean);
  for (const num of tryNumbers) {
    const { data } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('twilio_phone_number', num)
      .maybeSingle();
    if (data?.id) return data.id;
  }
  // Fall back to a `vapi_*` config column if/when one is added; for now we
  // accept an explicit mapping via env (JSON: {"<phoneNumberId>":"<clientId>"}).
  if (phoneNumberId && process.env.VAPI_PHONE_TO_CLIENT) {
    try {
      const map = JSON.parse(process.env.VAPI_PHONE_TO_CLIENT);
      if (map[phoneNumberId]) return map[phoneNumberId];
      if (assistantId && map[assistantId]) return map[assistantId];
    } catch {}
  }
  return null;
}

function pickStructured(analysis) {
  if (!analysis || typeof analysis !== 'object') return {};
  return analysis.structuredData || analysis.structured_data || {};
}

function toIso(v) {
  if (!v) return null;
  try { return new Date(v).toISOString(); } catch { return null; }
}

async function upsertContactFromCall({ clientId, name, phone, email }) {
  if (!phone) return null;
  const { data: existing } = await supabaseAdmin
    .from('contacts').select('id, name, email')
    .eq('client_id', clientId).eq('phone', phone).maybeSingle();
  if (existing) {
    const patch = {};
    if (name && !existing.name) patch.name = name;
    if (email && !existing.email) patch.email = email;
    if (Object.keys(patch).length) {
      await supabaseAdmin.from('contacts').update(patch).eq('id', existing.id);
    }
    return existing.id;
  }
  const { data: created } = await supabaseAdmin.from('contacts').insert({
    client_id: clientId,
    name: name || phone,
    phone,
    email: email || null,
    source: 'vapi'
  }).select('id').single();
  return created?.id || null;
}

async function handleVapi(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Auth: shared secret in header (Vapi sends whatever you set as
  // serverUrlSecret; we accept either x-vapi-secret or x-vapi-signature
  // for forward compatibility).
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'missing_VAPI_WEBHOOK_SECRET' });
  const provided =
    req.headers['x-vapi-secret'] ||
    req.headers['x-vapi-signature'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!provided || !timingSafeEq(String(provided), secret)) {
    return res.status(401).json({ error: 'invalid_signature' });
  }

  const raw = await readRaw(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const msg = body.message || body; // Vapi nests under .message; tolerate either
  const type = msg.type || msg.event || 'unknown';
  const call = msg.call || {};
  const callId = call.id || msg.callId || null;
  if (!callId) return res.status(400).json({ error: 'missing_call_id' });

  const customerNumber = call.customer?.number || msg.customer?.number || null;
  const phoneNumberId = call.phoneNumberId || msg.phoneNumberId || null;
  const assistantId = call.assistantId || msg.assistantId || null;
  const toNumber = call.phoneNumber?.number || call.to || null;
  const fromNumber = call.from || null;

  const clientId = await resolveVapiClientId({
    phoneNumberId, assistantId, toNumber, fromNumber, customerNumber
  });
  if (!clientId) return res.status(422).json({ error: 'unknown_client', call_id: callId });

  // Build the row we want to upsert.
  const structured = pickStructured(msg.analysis);
  const direction =
    msg.direction || call.type === 'inboundPhoneCall' ? 'inbound' :
    call.type === 'outboundPhoneCall' ? 'outbound' : (msg.direction || null);

  const row = {
    client_id: clientId,
    vapi_call_id: callId,
    assistant_id: assistantId,
    phone_number_id: phoneNumberId,
    direction,
    from_number: fromNumber,
    to_number: toNumber,
    customer_number: customerNumber,
    status: msg.status || call.status || type,
    ended_reason: msg.endedReason || call.endedReason || null,
    started_at: toIso(msg.startedAt || call.startedAt),
    ended_at: toIso(msg.endedAt || call.endedAt),
    duration_seconds: typeof msg.durationSeconds === 'number'
      ? Math.round(msg.durationSeconds)
      : (typeof msg.duration === 'number' ? Math.round(msg.duration) : null),
    recording_url: msg.recordingUrl || call.recordingUrl || null,
    transcript: msg.transcript || null,
    summary: msg.summary || msg.analysis?.summary || null,
    structured_data: structured,
    cost_cents: typeof msg.cost === 'number' ? Math.round(msg.cost * 100) : null,
    payload: msg
  };

  // Upsert vapi_calls on the unique vapi_call_id.
  const { data: vapiRow, error: upErr } = await supabaseAdmin
    .from('vapi_calls')
    .upsert(row, { onConflict: 'vapi_call_id' })
    .select('id, lead_id, contact_id')
    .single();
  if (upErr) return res.status(500).json({ error: upErr.message });

  // For terminal events, fan out into contacts/leads/bookings.
  let leadId = vapiRow?.lead_id || null;
  let bookingId = null;

  if (type === 'end-of-call-report' || msg.endedReason || msg.endedAt) {
    const name = structured.name || structured.full_name ||
                 structured.caller_name || msg.customer?.name || null;
    const phone = structured.phone || structured.phone_number || customerNumber || null;
    const email = structured.email || null;

    const contactId = vapiRow?.contact_id ||
      await upsertContactFromCall({ clientId, name, phone, email });

    if (contactId && contactId !== vapiRow?.contact_id) {
      await supabaseAdmin.from('vapi_calls').update({ contact_id: contactId }).eq('id', vapiRow.id);
    }

    // Always create a lead row for an ended call so it shows up on the dash.
    const { data: leadRow } = await supabaseAdmin.from('leads').insert({
      client_id: clientId,
      contact_id: contactId,
      vapi_call_id: vapiRow.id,
      name,
      phone,
      email,
      source: 'vapi',
      intent: structured.intent || structured.reason || null,
      notes: msg.summary || msg.analysis?.summary || null,
      payload: structured
    }).select('id').single();
    leadId = leadRow?.id || leadId;
    if (leadId) {
      await supabaseAdmin.from('vapi_calls').update({ lead_id: leadId }).eq('id', vapiRow.id);
    }

    // If the assistant captured a booking, write it.
    const bookingStart = structured.booking_time || structured.appointment_time ||
                         structured.starts_at || null;
    if (bookingStart) {
      const { data: bk } = await supabaseAdmin.from('bookings').insert({
        client_id: clientId,
        contact_id: contactId,
        vapi_call_id: vapiRow.id,
        lead_id: leadId,
        service: structured.service || structured.appointment_type || 'Vapi booking',
        starts_at: toIso(bookingStart),
        ends_at: toIso(structured.ends_at || structured.end_time),
        status: structured.status || 'scheduled',
        notes: structured.notes || null,
        contact_name: name,
        contact_phone: phone,
        contact_email: email,
        source: 'vapi'
      }).select('id').single();
      bookingId = bk?.id || null;
    }
  }

  return res.status(200).json({
    ok: true,
    call_id: callId,
    vapi_row_id: vapiRow?.id || null,
    lead_id: leadId,
    booking_id: bookingId
  });
}

// ── Lead webhook (POST /api/webhooks/lead → ?action=lead) ──────────
// Called by embed/track.js when a form is submitted on a client website.
// No signature required — the slug + secret in the body is the auth.
async function handleLead(req, res) {
  // CORS — the beacon fires from the client's own domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GoElev8-Secret');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const raw = await readRaw(req);
  let body;
  try { body = raw ? JSON.parse(raw) : {}; }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const slug = body.slug;
  if (!slug) return res.status(400).json({ error: 'missing_slug' });

  // Resolve client (fetch all fields needed for welcome SMS)
  const { data: client } = await supabaseAdmin
    .from('clients').select('*').eq('slug', slug).maybeSingle();
  if (!client) return res.status(422).json({ error: 'unknown_client' });

  const name  = body.name  || null;
  const phone = body.phone || null;
  const email = body.email || null;
  if (!name && !phone && !email) return res.status(400).json({ error: 'no_contact_info' });

  const { data: lead, error } = await supabaseAdmin.from('leads').insert({
    client_id: client.id,
    name:   name,
    phone:  phone,
    email:  email,
    source: body.source || 'web_form',
    funnel: body.funnel || null,
    status: 'New',
    tags:   body.funnel ? [body.funnel] : []
  }).select('id').single();

  if (error) return res.status(500).json({ error: error.message });

  // Fire welcome SMS if enabled for this client
  let welcome = { sent: false, reason: 'no_phone' };
  if (phone) {
    try {
      welcome = await sendWelcomeForEvent({
        client,
        event: { contact_phone: phone, contact_name: name, contact_email: email, source: body.source || 'web_form' }
      });
    } catch (e) {
      welcome = { sent: false, reason: 'error: ' + e.message };
    }
  }

  return res.status(200).json({ ok: true, lead_id: lead?.id || null, welcome });
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
