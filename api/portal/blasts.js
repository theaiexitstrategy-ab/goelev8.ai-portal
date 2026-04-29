// SMS blast endpoint for client portals.
// GET  — list past blasts
// POST — send a new blast (credit-gated: deduct BEFORE sending)

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments } from '../../lib/twilio.js';
import { renderTemplate, firstName } from '../../lib/merge-tags.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  // blasts.client_id is text (slug), not uuid — resolve once
  const { data: client } = await supabaseAdmin
    .from('clients').select('slug').eq('id', clientId).single();
  const slug = client?.slug;
  if (!slug) return res.status(404).json({ error: 'client_not_found' });

  // ---------- GET: list blasts ----------
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('blasts')
      .select('*')
      .eq('client_id', slug)
      .order('sent_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ blasts: data || [] });
  }

  // ---------- POST: send blast ----------
  const { name, message, promoCode, segment, artistFilter } = await readJson(req);
  if (!name || !message) return res.status(400).json({ error: 'name_and_message_required' });

  // Build the recipient list. The 'contacts' segment pulls from the
  // contacts table (covers imported CSV uploads + funnel-sourced
  // contacts created by the nudge sequence). Every other segment pulls
  // from leads and applies a status/booking filter.
  let recipients = [];
  if (segment === 'contacts') {
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from('contacts').select('id, name, phone, email, opted_out')
      .eq('client_id', clientId);
    if (cErr) return res.status(500).json({ error: cErr.message });
    recipients = (contacts || [])
      .filter(c => c.phone && !c.opted_out)
      .map(c => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, _source: 'contact' }));
  } else {
    let query = supabaseAdmin.from('leads').select('*').eq('client_id', clientId);
    switch (segment) {
      case 'new':          query = query.eq('lead_status', 'New'); break;
      case 'booked':       query = query.eq('lead_status', 'Booked'); break;
      case 'first_timers': query = query.eq('booking_confirmed', false); break;
      case 'returning':    query = query.eq('booking_confirmed', true); break;
      case 'no_shows':     query = query.eq('lead_status', 'No Show'); break;
      case 'by_artist':    query = query.eq('artist_selected', artistFilter); break;
      // 'all' — no filter
    }
    const { data: leads, error: leadsErr } = await query;
    if (leadsErr) return res.status(500).json({ error: leadsErr.message });
    recipients = (leads || [])
      .filter(l => l.phone)
      .map(l => ({ id: l.id, name: l.name, phone: l.phone, email: l.email, _source: 'lead' }));
  }
  if (!recipients.length) return res.status(400).json({ error: 'no_recipients_with_phone' });

  // Credit gate: check balance BEFORE sending
  const { data: clientRow } = await supabaseAdmin
    .from('clients').select('credit_balance, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token').eq('id', clientId).single();
  const balance = clientRow?.credit_balance ?? 0;
  if (balance < recipients.length) {
    return res.status(402).json({
      error: 'insufficient_credits',
      required: recipients.length,
      available: balance
    });
  }

  // Deduct credits BEFORE firing SMS
  const newBalance = balance - recipients.length;
  await supabaseAdmin.from('clients')
    .update({ credit_balance: newBalance }).eq('id', clientId);

  let baseMessage = message;
  if (promoCode) baseMessage += `\n\nUse code: ${promoCode}`;

  const tw = twilioForClient(clientRow);
  const fromNumber = clientRow?.twilio_phone_number;
  const businessName = clientRow?.business_name || clientRow?.name || '';
  let sent = 0, failed = 0;
  for (const r of recipients) {
    const personalized = renderTemplate(baseMessage, {
      first_name: firstName(r.name),
      name: r.name || '',
      business_name: businessName,
      phone: r.phone || '',
      email: r.email || ''
    });
    const segments = estimateSegments(personalized);
    try {
      const twilioMsg = await tw.messages.create({
        to: r.phone,
        from: fromNumber,
        body: personalized,
        statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
      });
      sent++;

      // Link the message to whichever side we sourced from. For lead
      // sends, look up a matching contact to keep thread continuity.
      let contactId = null;
      let leadId = null;
      if (r._source === 'contact') {
        contactId = r.id;
      } else {
        leadId = r.id;
        const { data: existing } = await supabaseAdmin
          .from('contacts').select('id')
          .eq('client_id', clientId).eq('phone', r.phone).maybeSingle();
        contactId = existing?.id || null;
      }

      await supabaseAdmin.from('messages').insert({
        client_id: clientId,
        contact_id: contactId,
        lead_id: leadId,
        direction: 'outbound',
        body: personalized,
        segments,
        twilio_sid: twilioMsg.sid,
        status: twilioMsg.status,
        to_number: r.phone,
        from_number: fromNumber,
        credits_charged: 1
      });
      await supabaseAdmin.from('credit_ledger').insert({
        client_id: clientId, delta: -1, reason: 'sms_blast', ref_id: twilioMsg.sid
      });
    } catch {
      failed++;
    }
  }

  // If some failed, refund the difference
  if (failed > 0) {
    await supabaseAdmin.from('clients')
      .update({ credit_balance: newBalance + failed }).eq('id', clientId);
  }

  // Record blast
  await supabaseAdmin.from('blasts').insert({
    client_id: slug,
    blast_name: name,
    message_body: message,
    sent_at: new Date().toISOString(),
    total_recipients: recipients.length,
    delivered_count: sent,
    failed_count: failed,
    promo_code: promoCode || null,
    target_segment: segment || 'all',
    artist_filter: segment === 'by_artist' ? artistFilter : null,
    status: 'Sent'
  });

  return res.status(200).json({ sent, failed, credits_remaining: newBalance + failed });
}
