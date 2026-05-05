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

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;
  if (!clientId) return res.status(403).json({ error: 'no_client_assigned' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const leadId = url.searchParams.get('lead_id');
  if (!leadId) return res.status(400).json({ error: 'lead_id_required' });

  // Tolerate schemas missing paid_at (migration 0023 not applied).
  let leadRes = await supabaseAdmin.from('leads')
    .select('*').eq('id', leadId).eq('client_id', clientId).maybeSingle();
  if (leadRes.error && /column .*paid_at.* does not exist/i.test(leadRes.error.message)) {
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
