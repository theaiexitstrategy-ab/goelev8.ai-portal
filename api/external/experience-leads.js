// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Public POST endpoint called by tenant funnel sites at STEP 1 of a
// booking flow (before payment) so ABANDONED leads still get captured
// — closes gap #1 from the Konquered Balance integration spec: "a
// guest who completes the lead form but abandons at the deposit step
// leaves no trace at all."
//
// Auth: tenant write key. CORS locked per key.
// Rate limit: relies on Vercel's edge rate limiting + Supabase's
// intrinsic write throttling; no additional per-IP limiter here yet
// (small MVP surface). Add if abuse becomes a real problem.
//
// Body:
//   {
//     name, email, phone, goal,
//     experience_key?, experience_display?,
//     source?, source_url?
//   }
// Response: { ok, lead_id, booking_id }

import { supabaseAdmin } from '../../lib/supabase.js';
import { toE164 } from '../../lib/phone.js';
import { authTenantWriteKey, setCorsHeaders } from '../../lib/tenant-write-key.js';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    // Preflight — reflect any origin for OPTIONS since we haven't
    // authed yet. Actual origin gate lives on the auth path.
    setCorsHeaders(res, req.headers.origin || '*');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = await authTenantWriteKey(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error, ...(auth.origin ? { origin: auth.origin } : {}) });
  setCorsHeaders(res, auth.corsOrigin);

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }

  const first = String(body?.name || '').trim();
  const email = String(body?.email || '').trim();
  const phone = String(body?.phone || '').trim();
  if (!first) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ ok: false, error: 'valid_email_required' });
  const e164 = phone ? toE164(phone) : null;
  // Phone is required for KB deposit confirmations but optional here
  // — a name+email lead is still valuable. Log the normalization
  // failure but don't reject.

  // Split first/last cheaply — the site's form is a single "name"
  // field per the spec ("name" at Step 1). We keep the raw string in
  // the guest_name column too.
  const nameParts = first.split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  // Insert leads row (existing generic multi-tenant table). Tolerant
  // of unknown source column names — leads schema varies across
  // envs; core fields are name/phone/email/client_id.
  let leadId = null;
  {
    const leadRow = {
      client_id: auth.clientId,
      name:      first,
      phone:     e164 || phone || null,
      email,
      source:    String(body?.source || 'external_funnel').slice(0, 60)
    };
    let { data, error } = await supabaseAdmin.from('leads').insert(leadRow).select('id').single();
    if (error && /column .*(source|opted_out).* does not exist/i.test(error.message || '')) {
      const trimmed = { ...leadRow }; delete trimmed.source;
      const retry = await supabaseAdmin.from('leads').insert(trimmed).select('id').single();
      data = retry.data; error = retry.error;
    }
    if (!error && data) leadId = data.id;
    if (error) {
      // Log but don't fail — we still want experience_bookings row.
      console.warn('[experience-leads] leads insert warning:', error.message);
    }
  }

  // Insert experience_bookings row at status='lead'. Deposit step
  // will look this up by (lead_id or booking_id) and promote it.
  const { data: eb, error: ebErr } = await supabaseAdmin
    .from('experience_bookings').insert({
      client_id:          auth.clientId,
      lead_id:            leadId,
      status:             'lead',
      experience_key:     body?.experience_key || null,
      experience_display: body?.experience_display || null,
      guest_name:         first,
      guest_email:        email,
      guest_phone:        e164 || phone || null,
      goal:               body?.goal ? String(body.goal).slice(0, 500) : null,
      source:             String(body?.source || 'external_funnel').slice(0, 40),
      source_url:         body?.source_url ? String(body.source_url).slice(0, 512) : null
    }).select('id').single();
  if (ebErr) return res.status(500).json({ ok: false, error: 'experience_bookings_insert_failed', detail: ebErr.message });

  return res.status(200).json({ ok: true, lead_id: leadId, booking_id: eb.id });
}
