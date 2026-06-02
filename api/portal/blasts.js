// SMS blast endpoint for client portals.
// GET  — list past blasts
// POST — send a new blast (credit-gated: deduct BEFORE sending)
//
// Safety guards layered on POST:
//   1. Idempotency: a blast with the same name+message in the last 5
//      minutes returns the existing row instead of re-sending. Protects
//      operators who panic-click "Send Blast" when the request feels slow.
//   2. Per-number throttle: any recipient phone that has received an
//      outbound SMS from this tenant within the last hour is skipped.
//      No single number can be blasted twice within an hour no matter
//      how many times the operator clicks Send.
//   3. Live progress: the blasts row is inserted BEFORE the Twilio
//      loop with status='Sending', and delivered/failed counts are
//      updated every few sends so the client can poll and show progress.

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments } from '../../lib/twilio.js';
import { renderTemplate, firstName } from '../../lib/merge-tags.js';
import { toE164 } from '../../lib/phone.js';
import { getBillingClient } from '../../lib/credits.js';

const THROTTLE_MS = 60 * 60 * 1000;        // 1 hour per-number throttle
const IDEMPOTENCY_MS = 5 * 60 * 1000;       // 5-minute dupe-click window
const PROGRESS_UPDATE_EVERY = 5;            // write progress every N sends

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
  const { name, message, promoCode, segment, artistFilter, includeTags, excludeTags } =
    await readJson(req);
  if (!name || !message) return res.status(400).json({ error: 'name_and_message_required' });

  // --- Idempotency guard ---
  // Reject if a blast with the same name AND same message body was
  // recorded within the last 5 minutes. Returns the existing row so
  // the client can show "already sent" instead of double-charging.
  const idempotencyCutoff = new Date(Date.now() - IDEMPOTENCY_MS).toISOString();
  const { data: dupe } = await supabaseAdmin
    .from('blasts')
    .select('id, blast_name, status, delivered_count, failed_count, total_recipients, sent_at')
    .eq('client_id', slug)
    .eq('blast_name', name)
    .eq('message_body', message)
    .gte('sent_at', idempotencyCutoff)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (dupe) {
    return res.status(200).json({
      duplicate: true,
      blast_id: dupe.id,
      sent: dupe.delivered_count || 0,
      failed: dupe.failed_count || 0,
      total: dupe.total_recipients || 0,
      status: dupe.status,
      message: 'This blast was already sent within the last 5 minutes. Showing existing.'
    });
  }

  // Tag filters apply to leads and contacts uniformly.
  const includeArr = Array.isArray(includeTags)
    ? includeTags.map(t => String(t).trim()).filter(Boolean) : [];
  const excludeArr = Array.isArray(excludeTags)
    ? excludeTags.map(t => String(t).trim()).filter(Boolean) : [];

  // Build the recipient list.
  //   'contacts' — every contact (imported CSVs + funnel-sourced)
  //   'imported' — ONLY contacts whose source = 'import'  (CSV uploads)
  //   everything else — pulls from leads with a status/booking filter
  let recipients = [];
  if (segment === 'contacts' || segment === 'imported') {
    let cq = supabaseAdmin
      .from('contacts').select('id, name, phone, email, opted_out, tags, source')
      .eq('client_id', clientId);
    if (segment === 'imported') cq = cq.eq('source', 'import');
    if (includeArr.length) cq = cq.overlaps('tags', includeArr);
    const { data: contacts, error: cErr } = await cq;
    if (cErr) return res.status(500).json({ error: cErr.message });
    const hardExclude = new Set([...(excludeArr || []), 'Do Not Contact']);
    recipients = (contacts || [])
      .filter(c => c.phone && !c.opted_out)
      .filter(c => !(c.tags || []).some(t => hardExclude.has(t)))
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
    }
    if (includeArr.length) query = query.overlaps('tags', includeArr);

    let { data: leads, error: leadsErr } = await query.eq('opted_out', false);
    if (leadsErr && /column .*opted_out.* does not exist/i.test(leadsErr.message)) {
      const retry = await query;
      leads = retry.data; leadsErr = retry.error;
    }
    if (leadsErr) return res.status(500).json({ error: leadsErr.message });

    const hardExclude = new Set([...(excludeArr || []), 'Do Not Contact']);
    recipients = (leads || [])
      .filter(l => l.phone)
      .filter(l => !(l.tags || []).some(t => hardExclude.has(t)))
      .map(l => ({ id: l.id, name: l.name, phone: l.phone, email: l.email, _source: 'lead' }));
  }
  if (!recipients.length) return res.status(400).json({ error: 'no_recipients_with_phone' });

  // --- Per-number 1-hour throttle ---
  // Drop any recipient whose phone received an outbound SMS from this
  // tenant within the last hour. This is the hard safety net: even if
  // the operator clicks Send 5 times in 30 seconds, no number gets a
  // second message. Queries by client_id+direction+created_at — we
  // filter the matched phones in JS to avoid Supabase URL length
  // limits on huge .in() arrays.
  const throttleCutoff = new Date(Date.now() - THROTTLE_MS).toISOString();
  const { data: recentOutbound } = await supabaseAdmin
    .from('messages')
    .select('to_number')
    .eq('client_id', clientId)
    .eq('direction', 'outbound')
    .gte('created_at', throttleCutoff);
  const recentTos = new Set((recentOutbound || []).map(m => m.to_number).filter(Boolean));
  const beforeThrottle = recipients.length;
  recipients = recipients.filter(r => {
    const e = toE164(r.phone);
    return e && !recentTos.has(e);
  });
  const skippedRecent = beforeThrottle - recipients.length;
  if (!recipients.length) {
    return res.status(200).json({
      sent: 0,
      failed: 0,
      skipped_recent: skippedRecent,
      total: beforeThrottle,
      throttled: true,
      message: `All ${skippedRecent} recipient${skippedRecent === 1 ? '' : 's'} received an SMS from you within the last hour and were skipped.`
    });
  }

  // Credit gate: check balance BEFORE sending
  const { data: clientRow } = await supabaseAdmin
    .from('clients').select('id, business_name, name, parent_client_id, credit_balance, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token').eq('id', clientId).single();

  // Resolve to the billing client (parent, if any) for the credit pool +
  // Twilio config. Will Power Fitness Factory inherits both from Flex.
  const billingClient = await getBillingClient(supabaseAdmin, clientRow);
  const billingId = billingClient.id;

  const balance = billingClient?.credit_balance ?? 0;
  if (balance < recipients.length) {
    return res.status(402).json({
      error: 'insufficient_credits',
      required: recipients.length,
      available: balance
    });
  }

  // Deduct credits BEFORE firing SMS — debit hits the billing client.
  const newBalance = balance - recipients.length;
  await supabaseAdmin.from('clients')
    .update({ credit_balance: newBalance }).eq('id', billingId);

  // --- Create the blast row up front ---
  // Status='Sending' so the client poll can find it and show progress.
  // We update delivered/failed counts every PROGRESS_UPDATE_EVERY sends
  // and finalize the status at the end.
  const { data: blastRow, error: blastInsErr } = await supabaseAdmin
    .from('blasts')
    .insert({
      client_id: slug,
      blast_name: name,
      message_body: message,
      sent_at: new Date().toISOString(),
      total_recipients: recipients.length,
      delivered_count: 0,
      failed_count: 0,
      promo_code: promoCode || null,
      target_segment: segment || 'all',
      artist_filter: segment === 'by_artist' ? artistFilter : null,
      status: 'Sending'
    })
    .select('id')
    .single();
  if (blastInsErr) {
    // Refund the credits we already debited — we never sent anything.
    await supabaseAdmin.from('clients')
      .update({ credit_balance: balance }).eq('id', billingId);
    return res.status(500).json({ error: blastInsErr.message });
  }
  const blastId = blastRow.id;

  let baseMessage = message;
  if (promoCode) baseMessage += `\n\nUse code: ${promoCode}`;

  const tw = twilioForClient(billingClient);
  const fromNumber = billingClient?.twilio_phone_number;
  const businessName = clientRow?.business_name || clientRow?.name || '';
  let sent = 0, failed = 0;
  for (let idx = 0; idx < recipients.length; idx++) {
    const r = recipients[idx];
    const toE = toE164(r.phone);
    if (!toE) { failed++; continue; }
    const personalized = renderTemplate(baseMessage, {
      first_name: firstName(r.name),
      name: r.name || '',
      business_name: businessName,
      phone: toE,
      email: r.email || ''
    });
    const segments = estimateSegments(personalized);
    try {
      const twilioMsg = await tw.messages.create({
        to: toE,
        from: fromNumber,
        body: personalized,
        statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
      });
      sent++;

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
        to_number: toE,
        from_number: fromNumber,
        credits_charged: 1
      });
      await supabaseAdmin.from('credit_ledger').insert({
        client_id: billingId, delta: -1, reason: 'sms_blast', ref_id: twilioMsg.sid
      });
    } catch {
      failed++;
    }

    // Periodic progress update so the polling client sees the bar move.
    if (((idx + 1) % PROGRESS_UPDATE_EVERY === 0) || (idx + 1 === recipients.length)) {
      await supabaseAdmin.from('blasts')
        .update({ delivered_count: sent, failed_count: failed })
        .eq('id', blastId);
    }
  }

  // Refund any failed sends so the operator isn't double-charged.
  if (failed > 0) {
    await supabaseAdmin.from('clients')
      .update({ credit_balance: newBalance + failed }).eq('id', billingId);
  }

  // Finalize the blast row: status reflects outcome.
  const finalStatus = failed === 0 ? 'Sent' : (sent === 0 ? 'Failed' : 'Partial');
  await supabaseAdmin.from('blasts')
    .update({ delivered_count: sent, failed_count: failed, status: finalStatus })
    .eq('id', blastId);

  return res.status(200).json({
    sent,
    failed,
    total: recipients.length,
    skipped_recent: skippedRecent,
    blast_id: blastId,
    status: finalStatus,
    credits_remaining: newBalance + failed
  });
}
