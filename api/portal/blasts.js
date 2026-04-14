// SMS blast endpoint for client portals.
// GET  — list past blasts
// POST — send a new blast (credit-gated: deduct BEFORE sending)

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments } from '../../lib/twilio.js';

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

  // Build lead query based on segment
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

  const recipients = (leads || []).filter(l => l.phone);
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

  let finalMessage = message;
  if (promoCode) finalMessage += `\n\nUse code: ${promoCode}`;

  const tw = twilioForClient(clientRow);
  const fromNumber = clientRow?.twilio_phone_number;
  const segments = estimateSegments(finalMessage);
  let sent = 0, failed = 0;
  for (const lead of recipients) {
    try {
      const twilioMsg = await tw.messages.create({
        to: lead.phone,
        from: fromNumber,
        body: finalMessage,
        statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
      });
      sent++;

      // Resolve contact_id for thread linkage (best-effort).
      let contactId = null;
      const { data: existing } = await supabaseAdmin
        .from('contacts').select('id')
        .eq('client_id', clientId).eq('phone', lead.phone).maybeSingle();
      contactId = existing?.id || null;

      // Log the send so it shows up in the Messages tab thread view.
      // Blasts iterate over leads directly, so the lead_id is known.
      await supabaseAdmin.from('messages').insert({
        client_id: clientId,
        contact_id: contactId,
        lead_id: lead.id,
        direction: 'outbound',
        body: finalMessage,
        segments,
        twilio_sid: twilioMsg.sid,
        status: twilioMsg.status,
        to_number: lead.phone,
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
