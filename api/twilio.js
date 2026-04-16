import { supabaseAdmin } from '../lib/supabase.js';
import { estimateSegments } from '../lib/twilio.js';
import { sendPushToClient, sendPushToAdmins } from '../lib/push.js';

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

  // -------- status callback (message delivery updates) --------
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

  // -------- missed-call text-back --------
  // Twilio fires this statusCallback when an inbound call ends.
  // If the call was NOT answered (no-answer, busy, or failed), send an
  // auto-text-back SMS from the GoElev8 Twilio number with the client's
  // business name, and log the caller as a lead.
  if (action === 'missed_call') {
    const callStatus = (params.CallStatus || '').toLowerCase();
    const callerPhone = params.From;     // the person who called
    const calledNumber = params.To;      // the client's Twilio number

    // Only fire on genuinely missed calls
    if (!['no-answer', 'busy', 'failed'].includes(callStatus)) {
      return res.status(200).end();
    }
    if (!callerPhone || !calledNumber) {
      return res.status(200).end();
    }

    // Look up the client by the Twilio number that was called
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('id, name, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token')
      .eq('twilio_phone_number', calledNumber)
      .maybeSingle();
    if (!client) {
      console.warn('[twilio/missed_call] No client found for number', calledNumber);
      return res.status(200).end();
    }

    const businessName = client.name || 'our team';
    const smsBody =
      `Hey! Sorry we missed your call. We'd love to help — what can we assist you with today? ` +
      `Reply to this text and we'll get right back to you. - ${businessName}`;

    // Send the auto-text-back SMS
    const tw = (await import('../lib/twilio.js')).twilioForClient(client);
    let twilioMsg;
    try {
      twilioMsg = await tw.messages.create({
        from: calledNumber,
        to: callerPhone,
        body: smsBody,
        statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
      });
    } catch (err) {
      console.error('[twilio/missed_call] SMS send failed:', err.message);
      return res.status(200).end();
    }

    // Upsert a lead for this caller so it appears in the Leads tab
    const { data: existingLead } = await supabaseAdmin
      .from('leads')
      .select('id')
      .eq('client_id', client.id)
      .eq('phone', callerPhone)
      .maybeSingle();
    let leadId = existingLead?.id || null;
    if (!leadId) {
      const { data: newLead } = await supabaseAdmin
        .from('leads')
        .insert({
          client_id: client.id,
          phone: callerPhone,
          name: callerPhone,
          source: 'missed_call',
          status: 'new'
        })
        .select('id')
        .single();
      leadId = newLead?.id || null;
    }

    // Ensure a contact row exists so the message appears in the Messages
    // tab thread (the inbound webhook uses contacts for threading).
    let contactId = null;
    {
      let { data: contact } = await supabaseAdmin
        .from('contacts')
        .select('id')
        .eq('client_id', client.id)
        .eq('phone', callerPhone)
        .maybeSingle();
      if (!contact) {
        const { data: created } = await supabaseAdmin.from('contacts').insert({
          client_id: client.id, name: callerPhone, phone: callerPhone, source: 'missed_call'
        }).select('id').single();
        contact = created;
      }
      contactId = contact?.id || null;
    }

    // Log the outbound auto-reply in the messages table
    await supabaseAdmin.from('messages').insert({
      client_id: client.id,
      contact_id: contactId,
      lead_id: leadId,
      direction: 'outbound',
      body: smsBody,
      segments: estimateSegments(smsBody),
      twilio_sid: twilioMsg.sid,
      status: twilioMsg.status,
      to_number: callerPhone,
      from_number: calledNumber
    });

    // Push notification for missed call
    const missedDesc = `Missed call from ${callerPhone} — auto text-back sent`;
    await Promise.all([
      sendPushToClient(client.id, '📵 Missed Call', missedDesc, '/messages').catch(() => {}),
      sendPushToAdmins('📵 Missed Call — ' + (client.name || calledNumber), missedDesc, '/messages').catch(() => {})
    ]);

    return res.status(200).end();
  }

  // -------- inbound SMS --------
  if (action === 'inbound') {
    const from = params.From;
    const to = params.To;
    const body = (params.Body || '').trim();
    const sid = params.MessageSid;

    const { data: client } = await supabaseAdmin
      .from('clients').select('id, name').eq('twilio_phone_number', to).single();
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

    // Push notification for inbound SMS (skip TCPA keyword replies)
    if (!reply) {
      const senderName = contact?.name && contact.name !== from ? contact.name : from;
      const smsDesc = `${senderName}: ${body.length > 80 ? body.slice(0, 80) + '…' : body}`;
      await Promise.all([
        sendPushToClient(client.id, '💬 New SMS Reply', smsDesc, '/messages').catch(() => {}),
        sendPushToAdmins('💬 SMS — ' + (client.name || to), smsDesc, '/messages').catch(() => {})
      ]);
    }

    // STOP/START/HELP are TCPA-required responses — return them directly
    // instead of forwarding to Vapi, since compliance takes priority.
    if (reply) {
      // Log the auto-reply as an outbound message so it appears in the
      // Messages tab thread.
      await supabaseAdmin.from('messages').insert({
        client_id: client.id,
        contact_id: contact?.id || null,
        lead_id: leadId,
        direction: 'outbound',
        body: reply,
        segments: estimateSegments(reply),
        status: 'sent',
        to_number: from,
        from_number: to
      });
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${reply}</Message></Response>`);
    }

    // Forward the original Twilio payload to Vapi so the SMS assistant
    // can continue its conversation. Return Vapi's TwiML response to
    // Twilio. If Vapi is unreachable, return an empty TwiML so Twilio
    // doesn't error out.
    //
    // Vapi's TwiML response contains the assistant's reply inside a
    // <Message> tag. We parse it out and log it as an outbound message
    // so the reply appears in the Messages tab thread alongside the
    // lead's inbound message.
    try {
      const vapiRes = await fetch(VAPI_SMS_FORWARD_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rawBody
      });
      const vapiTwiml = await vapiRes.text();

      // Extract reply text from TwiML: <Message>...reply...</Message>
      // Simple regex — TwiML from Vapi is well-formed single-message.
      const msgMatch = vapiTwiml.match(/<Message(?:\s[^>]*)?>([\s\S]*?)<\/Message>/i);
      if (msgMatch && msgMatch[1]) {
        const replyText = msgMatch[1].trim();
        if (replyText) {
          await supabaseAdmin.from('messages').insert({
            client_id: client.id,
            contact_id: contact?.id || null,
            lead_id: leadId,
            direction: 'outbound',
            body: replyText,
            segments: estimateSegments(replyText),
            status: 'sent',
            to_number: from,
            from_number: to
          });
        }
      }

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
