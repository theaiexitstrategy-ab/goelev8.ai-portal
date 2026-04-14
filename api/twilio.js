import { supabaseAdmin } from '../lib/supabase.js';
import { estimateSegments } from '../lib/twilio.js';

// Vapi handles SMS conversations on these numbers. After we log the
// inbound message we forward the original Twilio payload to Vapi and
// return whatever TwiML Vapi sends back. This way both systems work:
// the Messages tab gets the row AND Vapi's SMS assistant keeps replying.
const VAPI_SMS_FORWARD_URL = 'https://api.vapi.ai/twilio/sms';

async function parseForm(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  // Keep the raw form body around so we can forward it verbatim to Vapi.
  return { params: Object.fromEntries(new URLSearchParams(raw)), raw };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');
  const { params, raw: rawBody } = await parseForm(req);

  // -------- status callback --------
  if (action === 'status') {
    const sid = params.MessageSid;
    const status = params.MessageStatus;
    const errorCode = params.ErrorCode || null;
    if (sid) {
      await supabaseAdmin.from('messages')
        .update({ status, error_code: errorCode })
        .eq('twilio_sid', sid);
    }
    return res.status(200).end();
  }

  // -------- inbound SMS --------
  if (action === 'inbound') {
    const from = params.From;
    const to = params.To;
    const body = (params.Body || '').trim();
    const sid = params.MessageSid;

    const { data: client } = await supabaseAdmin
      .from('clients').select('id').eq('twilio_phone_number', to).single();
    if (!client) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    let { data: contact } = await supabaseAdmin
      .from('contacts').select('*').eq('client_id', client.id).eq('phone', from).maybeSingle();
    if (!contact) {
      const { data: created } = await supabaseAdmin.from('contacts').insert({
        client_id: client.id, name: from, phone: from, source: 'inbound_sms'
      }).select().single();
      contact = created;
    }

    const upper = body.toUpperCase();
    let reply = null;
    if (['STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT'].includes(upper)) {
      await supabaseAdmin.from('contacts').update({ opted_out: true }).eq('id', contact.id);
      reply = 'You have been unsubscribed and will no longer receive messages. Reply START to resubscribe.';
    } else if (upper === 'START' || upper === 'UNSTOP') {
      await supabaseAdmin.from('contacts').update({ opted_out: false }).eq('id', contact.id);
      reply = 'You have been resubscribed.';
    } else if (upper === 'HELP') {
      reply = 'Reply STOP to unsubscribe. Msg & data rates may apply.';
    }

    // Best-effort lead lookup so the Messages tab can render the
    // lead's name against this thread (and so future analytics can
    // attribute reply rates per lead).
    let leadId = null;
    {
      const { data: leadRow } = await supabaseAdmin
        .from('leads')
        .select('id')
        .eq('client_id', client.id)
        .eq('phone', from)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      leadId = leadRow?.id || null;
    }

    await supabaseAdmin.from('messages').insert({
      client_id: client.id, contact_id: contact.id, lead_id: leadId,
      direction: 'inbound',
      body, segments: estimateSegments(body), twilio_sid: sid,
      status: 'received', to_number: to, from_number: from
    });

    // STOP/START/HELP are TCPA-required responses — return them directly
    // instead of forwarding to Vapi, since compliance takes priority.
    if (reply) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Forward the original Twilio payload to Vapi so the SMS assistant
    // can continue its conversation. Return Vapi's TwiML response to
    // Twilio. If Vapi is unreachable, return an empty TwiML so Twilio
    // doesn't error out.
    try {
      const vapiRes = await fetch(VAPI_SMS_FORWARD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rawBody
      });
      const vapiTwiml = await vapiRes.text();
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(vapiTwiml);
    } catch (err) {
      console.error('[twilio/inbound] Vapi forward failed:', err.message);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }
  }

  return res.status(400).json({ error: 'unknown_action' });
}
