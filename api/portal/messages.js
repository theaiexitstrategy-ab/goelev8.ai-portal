import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilio, estimateSegments } from '../../lib/twilio.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;

  // GET: list messages, optionally for one contact (?contact_id=)
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const contactId = url.searchParams.get('contact_id');
    let q = sb.from('messages').select('*').eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(500);
    if (contactId) q = q.eq('contact_id', contactId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ messages: data });
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

  // Load client (for from-number + balance)
  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients').select('*').eq('id', clientId).single();
  if (cErr || !client) return res.status(500).json({ error: 'client_not_found' });
  if (!client.twilio_phone_number) return res.status(400).json({ error: 'no_twilio_number' });

  const segments = estimateSegments(text);
  if (client.credit_balance < segments) {
    return res.status(402).json({ error: 'insufficient_credits', need: segments, have: client.credit_balance });
  }

  // Atomically deduct credits BEFORE sending (prevents oversend on race)
  const { data: newBal, error: dErr } = await supabaseAdmin
    .rpc('consume_credits', { p_client_id: clientId, p_amount: segments });
  if (dErr) return res.status(402).json({ error: 'insufficient_credits' });

  // Send via Twilio
  let twilioMsg;
  try {
    twilioMsg = await twilio.messages.create({
      from: client.twilio_phone_number,
      to: destNumber,
      body: text,
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio/status`
    });
  } catch (err) {
    // Refund credits on hard failure
    await supabaseAdmin.rpc('add_credits', { p_client_id: clientId, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: clientId, delta: segments, reason: 'refund', ref_id: 'twilio_send_failed'
    });
    return res.status(502).json({ error: 'twilio_failed', detail: err.message });
  }

  // Persist message + ledger
  await supabaseAdmin.from('messages').insert({
    client_id: clientId,
    contact_id: contact?.id || null,
    direction: 'outbound',
    body: text,
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: destNumber,
    from_number: client.twilio_phone_number,
    credits_charged: segments
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id: clientId, delta: -segments, reason: 'sms_send', ref_id: twilioMsg.sid
  });

  // Auto-reload check
  if (client.auto_reload_enabled && newBal < client.auto_reload_threshold) {
    // Fire-and-forget — handled by stripe credits API
    try {
      await fetch(`${process.env.PORTAL_BASE_URL}/api/portal/credits/auto-reload-trigger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal': process.env.SUPABASE_SERVICE_ROLE_KEY },
        body: JSON.stringify({ client_id: clientId })
      });
    } catch {}
  }

  return res.status(200).json({ ok: true, sid: twilioMsg.sid, balance: newBal, segments });
}
