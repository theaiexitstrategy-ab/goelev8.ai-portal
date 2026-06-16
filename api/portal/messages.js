import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments, truncateForSms } from '../../lib/twilio.js';
import { toE164 } from '../../lib/phone.js';
import { getBillingClient } from '../../lib/credits.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;

  // GET: list messages, optionally for one contact (?contact_id=)
  // Uses supabaseAdmin (service-role) instead of the user-scoped client
  // because inbound messages are inserted by the Twilio webhook handler
  // (also via supabaseAdmin). The user-scoped JWT+RLS path can fail to
  // surface those rows when the session context for current_client_id()
  // doesn't propagate cleanly. The clientId is already validated by
  // requireUser(), so tenant isolation is still enforced.
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const contactId = url.searchParams.get('contact_id');
    let q = supabaseAdmin.from('messages').select('*').eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(1000);
    if (contactId) q = q.eq('contact_id', contactId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ messages: data || [] });
  }

  // POST: send an SMS
  const body = await readJson(req);
  const { contact_id, to, body: text } = body;
  if (!text || (!contact_id && !to)) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  // Resolve contact + destination number (verify ownership via RLS-bound select)
  let contact = null;
  let destNumber = to;
  if (contact_id) {
    const { data, error } = await sb.from('contacts').select('*').eq('id', contact_id).single();
    if (error || !data) return res.status(404).json({ error: 'contact_not_found' });
    contact = data;
    destNumber = data.phone;
    if (data.opted_out) return res.status(400).json({ error: 'contact_opted_out' });
  }

  // Load client (for parent linkage + tenant scope), then resolve to
  // the billing client (parent, if any). Tenants like Will Power Fitness
  // Factory have no Twilio number / credit pool of their own — they
  // share Flex Facility's via parent_client_id.
  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients').select('*').eq('id', clientId).single();
  if (cErr || !client) return res.status(500).json({ error: 'client_not_found' });
  const billingClient = await getBillingClient(supabaseAdmin, client);
  if (!billingClient.twilio_phone_number) return res.status(400).json({ error: 'no_twilio_number' });
  const billingId = billingClient.id;

  const e164 = toE164(destNumber);
  if (!e164) return res.status(400).json({ error: 'invalid_phone', detail: destNumber });
  destNumber = e164;

  const segments = estimateSegments(text);
  if (billingClient.credit_balance < segments) {
    return res.status(402).json({ error: 'insufficient_credits', need: segments, have: billingClient.credit_balance });
  }

  // Atomically deduct credits BEFORE sending (prevents oversend on race).
  // The debit hits the BILLING client (parent), so the shared pool is
  // the single source of truth for both portals.
  const { data: newBal, error: dErr } = await supabaseAdmin
    .rpc('consume_credits', { p_client_id: billingId, p_amount: segments });
  if (dErr) return res.status(402).json({ error: 'insufficient_credits' });

  // Send via Twilio (per-tenant subaccount if configured on the billing client).
  const tw = twilioForClient(billingClient);
  let twilioMsg;
  try {
    twilioMsg = await tw.messages.create({
      from: billingClient.twilio_phone_number,
      to: destNumber,
      body: truncateForSms(text),
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
    });
  } catch (err) {
    // Refund credits on hard failure (back to the billing client).
    await supabaseAdmin.rpc('add_credits', { p_client_id: billingId, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: billingId, delta: segments, reason: 'refund', ref_id: 'twilio_send_failed'
    });
    return res.status(502).json({ error: 'twilio_failed', detail: err.message });
  }

  // Persist message + ledger. Message rows stay with the originating
  // client (so Will sees his outbound texts in his Messages tab), but
  // the credit_ledger row is billed to the parent.
  await supabaseAdmin.from('messages').insert({
    client_id: clientId,
    contact_id: contact?.id || null,
    direction: 'outbound',
    body: text,
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: destNumber,
    from_number: billingClient.twilio_phone_number,
    credits_charged: segments
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id: billingId, delta: -segments, reason: 'sms_send', ref_id: twilioMsg.sid
  });

  // Auto-reload check — runs against the billing client so the parent's
  // top-up rules are what trigger when the shared pool drops.
  if (billingClient.auto_reload_enabled && newBal < billingClient.auto_reload_threshold) {
    try {
      await fetch(`${process.env.PORTAL_BASE_URL}/api/portal/credits?action=auto-reload-trigger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal': process.env.SUPABASE_SERVICE_ROLE_KEY },
        body: JSON.stringify({ client_id: billingId })
      });
    } catch {}
  }

  return res.status(200).json({ ok: true, sid: twilioMsg.sid, balance: newBal, segments });
}
