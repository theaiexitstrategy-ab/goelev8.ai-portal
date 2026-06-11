// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Tenant-agnostic transactional SMS helper. Extracted from
// lib/islay-sms.js — the pattern is identical across tenants, only
// the message body changes. Used by:
//   - lib/merch-ingest.js  → order-received SMS after Stripe checkout
//   - lib/islay-sms.js     → booking + inquiry confirmations
//   - any future per-tenant SMS that needs the same plumbing
//
// What this helper does, in order:
//   1. Estimates the segment count of the body (1 segment = 1 credit)
//   2. Checks the tenant has enough credit_balance to send
//   3. Atomically deducts credits via the consume_credits RPC
//   4. Sends via the tenant-scoped Twilio client (subaccount-aware)
//   5. On Twilio failure, refunds the credits + writes a refund ledger
//      row so the operator can see why
//   6. On success, writes a messages row (threaded to a contact if we
//      can find one) and a credit_ledger debit row
//
// 24-hour per-recipient dedupe is exposed via recentlySent() — callers
// decide whether to use it (e.g. order-received SMS dedupes; nudge
// drips that fan out over days do not).

import { supabaseAdmin } from './supabase.js';
import { twilioForClient, estimateSegments } from './twilio.js';
import { firstName } from './merge-tags.js';

// True if we already sent an outbound SMS to this phone for this
// tenant within the last 24 hours. Lightweight check — calls site
// should use it as a guard before sending dedupe-sensitive blasts.
export async function recentlySent(clientId, phone) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from('messages')
    .select('id')
    .eq('client_id', clientId)
    .eq('to_number', phone)
    .eq('direction', 'outbound')
    .gte('created_at', cutoff)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Core send. Returns { sent, sid?, segments?, reason? } — never throws.
// Callers that just want fire-and-forget can ignore the return value.
//
// opts.ledgerReason — what to write to credit_ledger.reason on the
//                     debit row. Defaults to 'transactional_sms' so
//                     reports can break the spend down by purpose.
// opts.refId        — value for credit_ledger.ref_id (Twilio sid by
//                     default; callers can override to e.g. a
//                     stripe_payment_id for reconciliation).
export async function sendTransactionalSms({ client, to, body, ledgerReason, refId } = {}) {
  if (!client?.twilio_phone_number) return { sent: false, reason: 'no_twilio_number' };
  if (!to || !/^\+?\d[\d\s\-().]{6,}$/.test(to)) return { sent: false, reason: 'invalid_phone' };
  if (!body) return { sent: false, reason: 'empty_body' };

  const segments = estimateSegments(body);
  if ((client.credit_balance ?? 0) < segments) {
    return { sent: false, reason: 'insufficient_credits' };
  }

  // Atomic deduct so two concurrent sends can't oversend a balance.
  const { error: dErr } = await supabaseAdmin
    .rpc('consume_credits', { p_client_id: client.id, p_amount: segments });
  if (dErr) return { sent: false, reason: 'consume_failed' };

  const tw = twilioForClient(client);
  let twilioMsg;
  try {
    twilioMsg = await tw.messages.create({
      from: client.twilio_phone_number,
      to,
      body,
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
    });
  } catch (err) {
    // Refund the credits we just deducted — the customer wasn't
    // actually charged-equivalent because the message never sent.
    await supabaseAdmin.rpc('add_credits', { p_client_id: client.id, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: client.id, delta: segments,
      reason: 'refund', ref_id: refId || 'twilio_failed'
    });
    return { sent: false, reason: 'twilio_failed: ' + err.message };
  }

  // Thread to a contact if one already exists for this phone — keeps
  // the operator's Messages tab grouped. We don't create one here;
  // contacts are owned by the import / lead-capture flows.
  let contactId = null;
  {
    const { data: existing } = await supabaseAdmin
      .from('contacts').select('id')
      .eq('client_id', client.id).eq('phone', to).maybeSingle();
    contactId = existing?.id || null;
  }

  await supabaseAdmin.from('messages').insert({
    client_id: client.id,
    contact_id: contactId,
    direction: 'outbound',
    body,
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: to,
    from_number: client.twilio_phone_number,
    credits_charged: segments
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id: client.id, delta: -segments,
    reason: ledgerReason || 'transactional_sms',
    ref_id: refId || twilioMsg.sid
  });

  return { sent: true, sid: twilioMsg.sid, segments };
}

// Order-received SMS for any tenant whose storefront uses
// /api/external/checkout. The body is intentionally short (single
// GSM-7 segment) so it doesn't get expensive to send on small carts.
// Includes a STOP footer for carrier + TCPA compliance.
//
// opts.stripePaymentId — used as credit_ledger.ref_id so the SMS spend
//                        is traceable back to the Stripe charge that
//                        triggered it.
export async function sendOrderReceivedSms({ client, to, customerName, stripePaymentId } = {}) {
  const first = firstName(customerName);
  const greet = first ? `Hey ${first}` : 'Hey there';
  const tenant = client?.name || 'the team';
  const body = `${greet}, ${tenant} here — we got your order! We'll ship within 72 hours and USPS usually delivers in 1–2 weeks. Reply here with any questions. Reply STOP to opt out.`;
  return sendTransactionalSms({
    client, to, body,
    ledgerReason: 'order_received_sms',
    refId: stripePaymentId || undefined
  });
}
