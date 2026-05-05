// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Customer profile aggregator.
//
// GET /api/portal/profile?lead_id=<uuid>
//
// Returns one consolidated payload for a single lead — the lead row
// itself plus every related artefact (bookings, vapi calls, messages,
// nudges, contact link). Used by the slide-over Profile panel so the
// operator can see who someone is and what they've done with the
// business in one click.
//
// Tenant-scoped: every related table query filters on the same client
// the lead belongs to, and the lead itself must match the authed
// tenant context.

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const AVATAR_BUCKET = 'lead-avatars';
const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;
  if (!clientId) return res.status(403).json({ error: 'no_client_assigned' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  // ---------- POST ?action=upload-avatar ----------
  // Body: { lead_id, image_data_url } where image_data_url is a
  //   data:image/<png|jpeg|webp>;base64,<...>
  // Or:   { lead_id, image_url } to set an external URL directly.
  if (req.method === 'POST' && action === 'upload-avatar') {
    const body = await readJson(req);
    const leadId = body?.lead_id;
    if (!leadId) return res.status(400).json({ error: 'lead_id_required' });

    // Verify the lead is in this tenant before mutating.
    const { data: lead } = await supabaseAdmin.from('leads')
      .select('id').eq('id', leadId).eq('client_id', clientId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });

    // External URL path — no upload, just write the URL.
    if (body.image_url) {
      const u = String(body.image_url).trim();
      if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'image_url_must_be_http_or_https' });
      const { error } = await supabaseAdmin.from('leads')
        .update({ avatar_url: u }).eq('id', leadId);
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ ok: true, avatar_url: u });
    }

    // Data URL path — decode + upload to Supabase Storage. Falls back
    // to inlining the data URL on leads.avatar_url if the bucket
    // doesn't exist (so the feature works before any storage setup).
    const dataUrl = body.image_data_url || '';
    const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/i.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'image_data_url_required (data:image/...;base64,...)' });
    const mimeType = m[1].toLowerCase();
    const ext = mimeType.replace('image/', '').replace('jpeg', 'jpg');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({ error: 'avatar_too_large_max_2mb' });
    }

    const objectPath = `${clientId}/${leadId}.${ext}`;
    let publicUrl = null;
    let uploadErr = null;
    try {
      const upRes = await supabaseAdmin.storage
        .from(AVATAR_BUCKET)
        .upload(objectPath, buf, { contentType: mimeType, upsert: true });
      uploadErr = upRes.error;
      if (!uploadErr) {
        const { data: pub } = supabaseAdmin.storage
          .from(AVATAR_BUCKET).getPublicUrl(objectPath);
        publicUrl = pub?.publicUrl || null;
      }
    } catch (e) { uploadErr = e; }

    // Inline-fallback path: bucket not found / not public / etc.
    // Storing the data URL directly works but bloats the leads row;
    // ok for occasional photos, not for a whole CRM.
    if (!publicUrl) {
      if (buf.length > 256 * 1024) {
        return res.status(400).json({
          error: 'storage_unavailable_and_image_too_large_for_inline',
          hint: 'Create a public bucket "lead-avatars" in Supabase Storage, or upload an image under 256 KB.',
          upload_error: uploadErr?.message || null
        });
      }
      const inline = dataUrl;
      const { error } = await supabaseAdmin.from('leads')
        .update({ avatar_url: inline }).eq('id', leadId);
      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({
        ok: true, avatar_url: inline,
        storage: 'inline_fallback',
        note: 'Stored as inline data URL — create a public "lead-avatars" Supabase Storage bucket to use Storage instead.'
      });
    }

    const { error } = await supabaseAdmin.from('leads')
      .update({ avatar_url: publicUrl }).eq('id', leadId);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true, avatar_url: publicUrl, storage: 'supabase' });
  }

  // ---------- DELETE ?action=avatar ----------
  if (req.method === 'DELETE' && action === 'avatar') {
    const body = await readJson(req);
    const leadId = body?.lead_id;
    if (!leadId) return res.status(400).json({ error: 'lead_id_required' });
    const { data: lead } = await supabaseAdmin.from('leads')
      .select('id, avatar_url').eq('id', leadId).eq('client_id', clientId).maybeSingle();
    if (!lead) return res.status(404).json({ error: 'lead_not_found' });
    // Best-effort storage cleanup if it looks like one of our objects.
    if (lead.avatar_url && lead.avatar_url.includes(`/${AVATAR_BUCKET}/`)) {
      try {
        const path = lead.avatar_url.split(`/${AVATAR_BUCKET}/`)[1];
        if (path) await supabaseAdmin.storage.from(AVATAR_BUCKET).remove([path]);
      } catch {}
    }
    await supabaseAdmin.from('leads').update({ avatar_url: null }).eq('id', leadId);
    return res.status(200).json({ ok: true });
  }

  // ---------- GET (existing profile aggregator) ----------
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const leadId = url.searchParams.get('lead_id');
  if (!leadId) return res.status(400).json({ error: 'lead_id_required' });

  // Tolerate schemas missing paid_at / avatar_url. SELECT * returns
  // every column the schema actually has, so the leaner retry only
  // fires if something errors at parse time (rare).
  let leadRes = await supabaseAdmin.from('leads')
    .select('*').eq('id', leadId).eq('client_id', clientId).maybeSingle();
  if (leadRes.error && /column .*\b(paid_at|avatar_url)\b.* does not exist/i.test(leadRes.error.message)) {
    leadRes = await supabaseAdmin.from('leads')
      .select('id, client_id, contact_id, vapi_call_id, name, phone, email, source, funnel, intent, status, notes, tags, created_at')
      .eq('id', leadId).eq('client_id', clientId).maybeSingle();
  }
  if (!leadRes.data) return res.status(404).json({ error: 'lead_not_found' });
  const lead = leadRes.data;

  // Fan out — everything keyed off the lead OR the matching
  // phone/email/contact_id since some legacy rows aren't directly
  // joined by lead_id.
  const phone = lead.phone || null;
  const email = lead.email || null;

  const [bookingsR, callsR, messagesR, nudgesR, contactR] = await Promise.all([
    // Bookings: prefer lead_id, fall back to contact_phone/email match.
    (async () => {
      const orParts = [`lead_id.eq.${leadId}`];
      if (phone) orParts.push(`phone.eq.${phone}`);
      if (email) orParts.push(`email.eq.${email}`);
      let q = supabaseAdmin.from('bookings')
        .select('id, service, service_type, starts_at, status, source, lead_name, phone, email, created_at, tags, paid_at, notes')
        .eq('client_id', clientId)
        .or(orParts.join(','))
        .order('starts_at', { ascending: false })
        .limit(50);
      let r = await q;
      if (r.error && /column .*\b(tags|paid_at)\b.* does not exist/i.test(r.error.message)) {
        r = await supabaseAdmin.from('bookings')
          .select('id, service, service_type, starts_at, status, source, lead_name, phone, email, created_at, notes')
          .eq('client_id', clientId)
          .or(orParts.join(','))
          .order('starts_at', { ascending: false }).limit(50);
      }
      return r.data || [];
    })(),
    (async () => {
      const orParts = [`lead_id.eq.${leadId}`];
      if (phone) orParts.push(`customer_number.eq.${phone}`);
      const r = await supabaseAdmin.from('vapi_calls')
        .select('id, vapi_call_id, direction, customer_number, status, ended_reason, started_at, ended_at, duration_seconds, summary, created_at')
        .eq('client_id', clientId)
        .or(orParts.join(','))
        .order('started_at', { ascending: false })
        .limit(50);
      return r.data || [];
    })(),
    (async () => {
      const orParts = [`lead_id.eq.${leadId}`];
      if (phone) orParts.push(`to_number.eq.${phone}`, `from_number.eq.${phone}`);
      const r = await supabaseAdmin.from('messages')
        .select('id, direction, body, status, to_number, from_number, created_at')
        .eq('client_id', clientId)
        .or(orParts.join(','))
        .order('created_at', { ascending: false })
        .limit(50);
      return r.data || [];
    })(),
    (async () => {
      const r = await supabaseAdmin.from('nudge_queue')
        .select('id, message_number, scheduled_for, sent_at, failed_reason, message_body')
        .eq('client_id', clientId)
        .eq('lead_id', leadId)
        .order('message_number', { ascending: true });
      return r.data || [];
    })(),
    (async () => {
      if (!lead.contact_id && !phone) return null;
      let q = supabaseAdmin.from('contacts').select('*').eq('client_id', clientId);
      if (lead.contact_id) q = q.eq('id', lead.contact_id);
      else q = q.eq('phone', phone);
      const r = await q.maybeSingle();
      return r.data || null;
    })()
  ]);

  // Compute a couple of summary numbers for the header.
  const totalBookings = bookingsR.length;
  const paidBookings = bookingsR.filter(b => b.paid_at).length;
  const lastInteraction = [
    lead.created_at,
    bookingsR[0]?.created_at,
    callsR[0]?.created_at,
    messagesR[0]?.created_at
  ].filter(Boolean).sort().pop() || lead.created_at;

  return res.status(200).json({
    lead,
    contact: contactR,
    bookings: bookingsR,
    calls: callsR,
    messages: messagesR,
    nudges: nudgesR,
    summary: {
      total_bookings: totalBookings,
      paid_bookings: paidBookings,
      last_interaction: lastInteraction,
      total_calls: callsR.length,
      total_messages: messagesR.length
    }
  });
}
