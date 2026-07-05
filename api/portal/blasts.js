// SMS blast endpoint for client portals.
// GET  — list past blasts + send-limit status
// POST — send a new blast (credit-gated: deduct BEFORE sending)
//
// Safety guards layered on POST (in order of evaluation):
//   1. Tenant hour throttle:    at most 1 blast per hour per tenant.
//                               Hard reject (429) when violated.
//   2. Tenant day throttle:     at most 2 blasts per rolling 24h per
//                               tenant. Hard reject (429) when violated.
//   3. Idempotency:             same name+message in last 5 min returns
//                               the existing row instead of re-sending.
//   4. Per-number throttle:     any recipient phone that received an
//                               outbound SMS from this tenant in the
//                               last hour is dropped from the recipient
//                               list. Layered safety net on top of #1/2.
//   5. Opt-out compliance:      append "Reply STOP to opt out." to any
//                               message body that doesn't already
//                               contain STOP/UNSUBSCRIBE/CANCEL/END/QUIT.
//                               Required for carrier policy + TCPA.
//   6. Live progress:           the blasts row is inserted BEFORE the
//                               Twilio loop with status='Sending', and
//                               delivered/failed counts update every few
//                               sends so the client can poll progress.

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments, MMS_CREDIT_COST } from '../../lib/twilio.js';
import { renderTemplate, firstName } from '../../lib/merge-tags.js';
import { toE164 } from '../../lib/phone.js';
import { getBillingClient } from '../../lib/credits.js';

const THROTTLE_MS = 60 * 60 * 1000;         // 1 hour per-number throttle
const TENANT_HOUR_MS = 60 * 60 * 1000;      // 1 blast / hour at tenant level
const TENANT_DAY_MS = 24 * 60 * 60 * 1000;  // 2 blasts / 24h at tenant level
const TENANT_DAY_MAX = 2;
const IDEMPOTENCY_MS = 5 * 60 * 1000;       // 5-minute dupe-click window
const PROGRESS_UPDATE_EVERY = 5;            // write progress every N sends

// Match the standard carrier-recognized opt-out keywords. If a message
// body already contains any of these the operator added their own
// language and we leave it alone — otherwise we auto-append "Reply STOP
// to opt out." so every blast meets carrier + TCPA compliance.
const OPT_OUT_REGEX = /\b(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|OPT[\s-]?OUT)\b/i;
const OPT_OUT_SUFFIX = '\n\nReply STOP to opt out.';

// Count recipients that would match a given segment + tag filter for
// a tenant. Used by the SMS Blast modal's live segment-counter to show
// "500 contacts × $0.04 = $20.00" before the operator clicks Send.
// Mirrors the filter logic in the POST path so the count matches what
// the actual blast would target.
//
// Returns just the count — never reads phone numbers / contact rows —
// so this is cheap to call on every segment/tag change in the UI.
async function countRecipientsForSegment({ clientId, segment, includeTags, excludeTags, artistFilter }) {
  const includeArr = Array.isArray(includeTags)
    ? includeTags.map(t => String(t).trim()).filter(Boolean) : [];
  const excludeArr = Array.isArray(excludeTags)
    ? excludeTags.map(t => String(t).trim()).filter(Boolean) : [];
  const hardExclude = new Set([...(excludeArr || []), 'Do Not Contact']);

  if (segment === 'contacts' || segment === 'imported') {
    let cq = supabaseAdmin
      .from('contacts').select('id, phone, opted_out, tags')
      .eq('client_id', clientId);
    if (segment === 'imported') cq = cq.eq('source', 'import');
    if (includeArr.length) cq = cq.overlaps('tags', includeArr);
    const { data, error } = await cq;
    if (error) return { count: 0, error: error.message };
    const filtered = (data || [])
      .filter(c => c.phone && !c.opted_out)
      .filter(c => !(c.tags || []).some(t => hardExclude.has(t)));
    return { count: filtered.length };
  }

  let query = supabaseAdmin
    .from('leads').select('id, phone, tags').eq('client_id', clientId);
  switch (segment) {
    case 'new':          query = query.eq('lead_status', 'New'); break;
    case 'booked':       query = query.eq('lead_status', 'Booked'); break;
    case 'first_timers': query = query.eq('booking_confirmed', false); break;
    case 'returning':    query = query.eq('booking_confirmed', true); break;
    case 'no_shows':     query = query.eq('lead_status', 'No Show'); break;
    case 'by_artist':    query = query.eq('artist_selected', artistFilter); break;
  }
  if (includeArr.length) query = query.overlaps('tags', includeArr);

  // Mirror the POST path's opted_out tolerance: try with the filter,
  // fall back without it if the column doesn't exist yet.
  let { data, error } = await query.eq('opted_out', false);
  if (error && /column .*opted_out.* does not exist/i.test(error.message || '')) {
    const retry = await query;
    data = retry.data; error = retry.error;
  }
  if (error) return { count: 0, error: error.message };
  const filtered = (data || [])
    .filter(l => l.phone)
    .filter(l => !(l.tags || []).some(t => hardExclude.has(t)));
  return { count: filtered.length };
}

// Returns { count_hour, count_day, last_sent_at, next_available_at }
// for the tenant's blast history. Treats 'Sending'/'Sent'/'Partial' as
// counted — only 'Failed' (zero deliveries) is exempt so an operator
// can immediately retry a totally-failed blast.
async function getBlastLimits(slug) {
  const hourCutoff = new Date(Date.now() - TENANT_HOUR_MS).toISOString();
  const dayCutoff  = new Date(Date.now() - TENANT_DAY_MS).toISOString();
  const { data: recent } = await supabaseAdmin
    .from('blasts')
    .select('id, sent_at, status')
    .eq('client_id', slug)
    .gte('sent_at', dayCutoff)
    .order('sent_at', { ascending: false });
  const rows = (recent || []).filter(r => (r.status || '').toLowerCase() !== 'failed');
  const inDay  = rows.length;
  const inHour = rows.filter(r => r.sent_at >= hourCutoff).length;
  const lastSentAt = rows[0]?.sent_at || null;
  // Next available is the later of:
  //   - 1 hour after the most-recent blast (hour throttle)
  //   - 24 hours after the OLDEST blast in the window if at the day cap
  let nextAvailableAt = null;
  if (inHour >= 1 && lastSentAt) {
    nextAvailableAt = new Date(new Date(lastSentAt).getTime() + TENANT_HOUR_MS).toISOString();
  }
  if (inDay >= TENANT_DAY_MAX) {
    const oldest = rows[rows.length - 1]?.sent_at;
    if (oldest) {
      const dayUnblock = new Date(new Date(oldest).getTime() + TENANT_DAY_MS).toISOString();
      if (!nextAvailableAt || dayUnblock > nextAvailableAt) nextAvailableAt = dayUnblock;
    }
  }
  return {
    count_hour: inHour,
    count_day:  inDay,
    max_per_hour: 1,
    max_per_day:  TENANT_DAY_MAX,
    last_sent_at: lastSentAt,
    next_available_at: nextAvailableAt
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  // blasts.client_id is text (slug), not uuid — resolve once
  const { data: client } = await supabaseAdmin
    .from('clients').select('slug').eq('id', clientId).single();
  const slug = client?.slug;
  if (!slug) return res.status(404).json({ error: 'client_not_found' });

  // ---------- GET: list blasts + send-limit status ----------
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get('action');

    // Live recipient count for the blast composer's segment counter.
    // Mirrors the POST path's filters so the count shown in the UI
    // matches what an actual send would target.
    if (action === 'count-recipients') {
      const segment = url.searchParams.get('segment') || 'contacts';
      const artistFilter = url.searchParams.get('artistFilter') || null;
      const csv = (v) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
      const includeTags = csv(url.searchParams.get('includeTags'));
      const excludeTags = csv(url.searchParams.get('excludeTags'));
      const result = await countRecipientsForSegment({
        clientId, segment, includeTags, excludeTags, artistFilter
      });
      return res.status(200).json({ segment, count: result.count, error: result.error });
    }

    const [{ data, error }, limits] = await Promise.all([
      supabaseAdmin
        .from('blasts')
        .select('*')
        .eq('client_id', slug)
        .order('sent_at', { ascending: false }),
      getBlastLimits(slug)
    ]);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ blasts: data || [], limits });
  }

  // ---------- POST: send blast ----------
  const { name, message: rawMessage, promoCode, segment, artistFilter, includeTags, excludeTags, media_url } =
    await readJson(req);
  const hasMedia = !!media_url;
  // MMS blasts allow an empty body (image-only). SMS blasts still
  // require a message.
  if (!name || (!rawMessage && !hasMedia)) return res.status(400).json({ error: 'name_and_message_required' });

  // --- Tenant-level hour + day throttle ---
  // Hard reject if this tenant already sent a blast in the last hour
  // OR has hit the 2-blasts-per-24h cap. This is the safety net the
  // operator can't accidentally bypass by changing the blast name or
  // segment. Per-number throttle below remains as a second line of
  // defense for in-flight races.
  const limits = await getBlastLimits(slug);
  if (limits.count_hour >= limits.max_per_hour) {
    return res.status(429).json({
      error: 'tenant_hour_throttle',
      reason: 'You already sent a blast within the last hour. The limit is 1 blast per hour.',
      limits
    });
  }
  if (limits.count_day >= limits.max_per_day) {
    return res.status(429).json({
      error: 'tenant_day_throttle',
      reason: `You\'ve hit the daily limit of ${limits.max_per_day} blasts per 24 hours.`,
      limits
    });
  }

  // --- Opt-out compliance ---
  // Carrier policy + TCPA require every promotional SMS to include an
  // opt-out instruction. If the operator already added STOP / UNSUBSCRIBE
  // / similar in their copy, leave it alone. Otherwise auto-append a
  // standard footer so we don't ship a non-compliant blast.
  // Image-only MMS blasts (no body) skip the auto-append — the recipient
  // still has the standard STOP handling from earlier messages in the
  // conversation and there's no text to append to.
  let message = String(rawMessage || '');
  let optOutAutoAppended = false;
  if (message && !OPT_OUT_REGEX.test(message)) {
    message = message.trimEnd() + OPT_OUT_SUFFIX;
    optOutAutoAppended = true;
  }

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
  // Drop any recipient whose phone received a BLAST SMS from this
  // tenant within the last hour. This is the hard safety net: even
  // if the operator clicks Send 5 times in 30 seconds (or changes the
  // blast name to bypass the idempotency guard), no single number
  // gets a second blast within an hour.
  //
  // Critical: only filter on rows where blast_id IS NOT NULL. A
  // 1-on-1 message the operator sent from the Messages tab must NOT
  // block the next legitimate blast to that contact — replying in
  // a thread is normal CRM behavior, not a throttled event.
  //
  // Falls back to the broader outbound filter if the blast_id column
  // doesn't exist yet (pre-migration projects) so the safety net is
  // never weaker than it was before.
  const throttleCutoff = new Date(Date.now() - THROTTLE_MS).toISOString();
  let recentOutbound = null;
  {
    const r = await supabaseAdmin
      .from('messages')
      .select('to_number')
      .eq('client_id', clientId)
      .eq('direction', 'outbound')
      .not('blast_id', 'is', null)
      .gte('created_at', throttleCutoff);
    if (r.error && /column .*blast_id.* does not exist/i.test(r.error.message || '')) {
      const fallback = await supabaseAdmin
        .from('messages')
        .select('to_number')
        .eq('client_id', clientId)
        .eq('direction', 'outbound')
        .gte('created_at', throttleCutoff);
      recentOutbound = fallback.data;
    } else {
      recentOutbound = r.data;
    }
  }
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

  // Credit gate: check balance BEFORE sending. Blasts are billed per
  // SEGMENT × recipient — a 161-char message ships as 2 segments and
  // costs 2 credits per recipient. The per-message cap that the
  // global 160-char ceiling enforces on every OTHER outbound path
  // is intentionally NOT applied here: operators expect blasts to
  // ship the full message and pay the multi-segment cost.
  const { data: clientRow } = await supabaseAdmin
    .from('clients').select('id, business_name, name, parent_client_id, credit_balance, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token').eq('id', clientId).single();

  // Resolve to the billing client (parent, if any) for the credit pool +
  // Twilio config. Will Power Fitness Factory inherits both from Flex.
  const billingClient = await getBillingClient(supabaseAdmin, clientRow);
  const billingId = billingClient.id;

  // Cost per recipient:
  //   MMS blast (media attached) → flat MMS_CREDIT_COST regardless of
  //     body length. Twilio bills MMS as a single message.
  //   SMS blast → segments from the template (with opt-out + promo
  //     pre-baked). Per-recipient personalization adds a few chars for
  //     first_name etc, which can occasionally push a borderline message
  //     over a segment boundary — the per-send credit_ledger row below
  //     records the ACTUAL segment count for that recipient so the ledger
  //     stays honest. The upfront deduction is the conservative estimate,
  //     refunded on failure or under-charge.
  let estimateBody = String(message);
  if (promoCode) estimateBody += `\n\nUse code: ${promoCode}`;
  const segmentsPerRecipient = hasMedia
    ? MMS_CREDIT_COST
    : Math.max(1, estimateSegments(estimateBody));

  const totalCreditsNeeded = recipients.length * segmentsPerRecipient;
  const balance = billingClient?.credit_balance ?? 0;
  if (balance < totalCreditsNeeded) {
    return res.status(402).json({
      error: 'insufficient_credits',
      required: totalCreditsNeeded,
      available: balance,
      segments_per_recipient: segmentsPerRecipient,
      recipients: recipients.length
    });
  }

  // Deduct credits BEFORE firing SMS — debit hits the billing client.
  const newBalance = balance - totalCreditsNeeded;
  await supabaseAdmin.from('clients')
    .update({ credit_balance: newBalance }).eq('id', billingId);

  // --- Create the blast row up front ---
  // Status='Sending' so the client poll can find it and show progress.
  // We update delivered/failed counts every PROGRESS_UPDATE_EVERY sends
  // and finalize the status at the end.
  const blastInsertRow = {
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
    status: 'Sending',
    media_url: hasMedia ? media_url : null
  };
  let { data: blastRow, error: blastInsErr } = await supabaseAdmin
    .from('blasts').insert(blastInsertRow).select('id').single();
  if (blastInsErr && /column .*media_url.* does not exist/i.test(blastInsErr.message || '')) {
    // Migration hasn't landed — retry without the MMS column so the
    // blast still ships. The per-message media still sends via Twilio
    // (mediaUrl in the create call); only the blast-history summary
    // column is skipped.
    const { media_url: _drop, ...legacy } = blastInsertRow;
    const retry = await supabaseAdmin.from('blasts').insert(legacy).select('id').single();
    blastRow = retry.data; blastInsErr = retry.error;
  }
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
    // Blasts intentionally bypass the global 160-char truncation —
    // operators expect their full message to ship and are billed by
    // segment in the credit math above. The recipient receives the
    // full personalized body verbatim. For MMS blasts, we bill the
    // flat MMS_CREDIT_COST (already deducted up front) and pass the
    // image URL to Twilio as mediaUrl.
    const segments = hasMedia ? MMS_CREDIT_COST : estimateSegments(personalized);
    const twilioPayload = {
      to: toE,
      from: fromNumber,
      body: personalized,
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
    };
    if (hasMedia) twilioPayload.mediaUrl = [media_url];
    try {
      const twilioMsg = await tw.messages.create(twilioPayload);
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

      const msgRow = {
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
        credits_charged: segments,
        // Stamping blast_id is what makes the per-number throttle
        // distinguish blast messages from 1-on-1 messages the
        // operator sent in the Messages tab.
        blast_id: blastId,
        media_url: hasMedia ? media_url : null,
        is_mms: hasMedia
      };
      let insRes = await supabaseAdmin.from('messages').insert(msgRow);
      if (insRes.error && /column .*(blast_id|media_url|is_mms).* does not exist/i.test(insRes.error.message || '')) {
        // Drop optional MMS + blast_id columns for older schemas so the
        // core row still lands.
        const { blast_id: _b, media_url: _m, is_mms: _i, ...legacy } = msgRow;
        await supabaseAdmin.from('messages').insert(legacy);
      }
      await supabaseAdmin.from('credit_ledger').insert({
        client_id: billingId, delta: -segments,
        reason: hasMedia ? 'mms_blast' : 'sms_blast',
        ref_id: twilioMsg.sid
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
  // Each failure refunds segmentsPerRecipient (matches what was
  // deducted up front).
  const refunded = failed * segmentsPerRecipient;
  if (refunded > 0) {
    await supabaseAdmin.from('clients')
      .update({ credit_balance: newBalance + refunded }).eq('id', billingId);
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
    credits_remaining: newBalance + refunded,
    segments_per_recipient: segmentsPerRecipient,
    credits_charged: totalCreditsNeeded - refunded,
    opt_out_appended: optOutAutoAppended
  });
}
