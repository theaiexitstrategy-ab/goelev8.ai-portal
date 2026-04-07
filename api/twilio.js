import { supabaseAdmin } from '../lib/supabase.js';
import { estimateSegments } from '../lib/twilio.js';

async function parseForm(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');
  const params = await parseForm(req);

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

    await supabaseAdmin.from('messages').insert({
      client_id: client.id, contact_id: contact.id, direction: 'inbound',
      body, segments: estimateSegments(body), twilio_sid: sid,
      status: 'received', to_number: to, from_number: from
    });

    res.setHeader('Content-Type', 'text/xml');
    if (reply) return res.status(200).send(`<Response><Message>${reply}</Message></Response>`);
    return res.status(200).send('<Response></Response>');
  }

  return res.status(400).json({ error: 'unknown_action' });
}
