import { supabaseAdmin } from '../lib/supabase.js';
import { estimateSegments, truncateForSms } from '../lib/twilio.js';
import { sendPushToClient, sendPushToAdmins } from '../lib/push.js';

const MMS_BUCKET = 'mms-attachments';

// Re-host an inbound MMS attachment from Twilio's authenticated media
// URL into our public Supabase Storage bucket so the browser can render
// <img src=…> directly without proxying Twilio Basic-Auth requests.
//
// Twilio media URLs live at
//   https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages/{SID}/Media/{MID}
// and require Basic Auth with the (sub)account SID + auth token. Once
// fetched, we upload the raw bytes to mms-attachments and return the
// public HTTPS URL. Returns null on any failure — callers should
// gracefully fall back to storing null on the message row so the
// inbound row still lands.
async function rehostInboundMms({ client, mediaUrl, contentType, sid, index }) {
  try {
    // Twilio requires Basic Auth with the account (or subaccount) that
    // owns the message. Prefer the client's subaccount creds when
    // present, else fall back to the parent account.
    const sidAuth = client.twilio_subaccount_sid || process.env.TWILIO_ACCOUNT_SID;
    const tokenAuth = client.twilio_auth_token || process.env.TWILIO_AUTH_TOKEN;
    if (!sidAuth || !tokenAuth) return null;
    const basic = Buffer.from(`${sidAuth}:${tokenAuth}`).toString('base64');
    const resp = await fetch(mediaUrl, { headers: { authorization: `Basic ${basic}` } });
    if (!resp.ok) return null;
    const mime = contentType || resp.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await resp.arrayBuffer());
    const extFromMime = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
      'image/gif': 'gif',  'image/webp': 'webp', 'image/heic': 'heic'
    }[mime.toLowerCase()] || 'jpg';
    const path = `${client.id}/inbound/${Date.now()}-${sid || 'msg'}-${index || 0}.${extFromMime}`;
    let upErr;
    {
      const r = await supabaseAdmin.storage.from(MMS_BUCKET)
        .upload(path, buf, { contentType: mime, upsert: false });
      upErr = r.error;
    }
    if (upErr && /Bucket not found/i.test(upErr.message || '')) {
      await supabaseAdmin.storage.createBucket(MMS_BUCKET, { public: true });
      const retry = await supabaseAdmin.storage.from(MMS_BUCKET)
        .upload(path, buf, { contentType: mime, upsert: false });
      upErr = retry.error;
    }
    if (upErr) return null;
    const { data: pub } = supabaseAdmin.storage.from(MMS_BUCKET).getPublicUrl(path);
    return pub?.publicUrl || null;
  } catch (e) {
    console.error('[twilio/inbound] MMS re-host failed:', e.message);
    return null;
  }
}

// Message insert with tolerant fallback for envs where the media_url /
// is_mms migration hasn't landed yet.
async function insertInboundMessage(row) {
  const { error } = await supabaseAdmin.from('messages').insert(row);
  if (error && /column .*(media_url|is_mms).* does not exist/i.test(error.message || '')) {
    const { media_url: _m, is_mms: _i, ...legacy } = row;
    await supabaseAdmin.from('messages').insert(legacy);
  }
}

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
        body: truncateForSms(smsBody),
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
      .from('clients')
      .select('id, name, twilio_subaccount_sid, twilio_auth_token')
      .eq('twilio_phone_number', to).single();
    if (!client) {
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }

    // MMS: Twilio sends NumMedia + MediaUrl0..N + MediaContentType0..N.
    // We re-host the first attachment in our public bucket so the
    // browser can render it inline without proxying Twilio Basic Auth.
    // Additional attachments (rare — usually 1 image per MMS) are
    // dropped for now; the primary attachment covers the common case.
    const numMedia = parseInt(params.NumMedia || '0', 10) || 0;
    let inboundMediaUrl = null;
    if (numMedia > 0 && params.MediaUrl0) {
      inboundMediaUrl = await rehostInboundMms({
        client,
        mediaUrl:    params.MediaUrl0,
        contentType: params.MediaContentType0,
        sid,
        index:       0
      });
    }
    const isMms = numMedia > 0;

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
      // Mark the contact opted-out + add the 'Do Not Contact' tag
      // (matches the nudges blocklist convention so they're suppressed
      // in every downstream system, not just blasts).
      const contactTags = new Set([...(contact.tags || []), 'Do Not Contact']);
      await supabaseAdmin.from('contacts')
        .update({ opted_out: true, tags: [...contactTags] })
        .eq('id', contact.id);

      // Propagate to EVERY matching lead in this tenant (same phone).
      // Lead-based blast segments (Funnel Leads, First Timers, etc.)
      // were silently bypassing the opt-out before this — now they
      // suppress too. We fetch the rows first so we can union the
      // tag array without an UPDATE … tags = ARRAY[…] overwrite.
      try {
        const { data: matchingLeads } = await supabaseAdmin
          .from('leads').select('id, tags')
          .eq('client_id', client.id).eq('phone', from);
        for (const ld of (matchingLeads || [])) {
          const ts = new Set([...(ld.tags || []), 'Do Not Contact']);
          await supabaseAdmin.from('leads')
            .update({ opted_out: true, tags: [...ts] })
            .eq('id', ld.id);
        }
      } catch (e) {
        // Tolerant if leads.opted_out column hasn't migrated yet —
        // retry without it.
        if (/column .*opted_out.* does not exist/i.test(e.message || '')) {
          const { data: matchingLeads } = await supabaseAdmin
            .from('leads').select('id, tags')
            .eq('client_id', client.id).eq('phone', from);
          for (const ld of (matchingLeads || [])) {
            const ts = new Set([...(ld.tags || []), 'Do Not Contact']);
            await supabaseAdmin.from('leads').update({ tags: [...ts] }).eq('id', ld.id);
          }
        } else {
          console.error('[twilio/inbound] opt-out propagation failed:', e.message);
        }
      }

      // Cancel any pending nudge queue rows for this lead so a STOP
      // also kills already-queued automation immediately, not just
      // future enrollments. Defense-in-depth alongside the nudges
      // cron's own re-check.
      try {
        const { data: matchingLeads2 } = await supabaseAdmin
          .from('leads').select('id').eq('client_id', client.id).eq('phone', from);
        const leadIds = (matchingLeads2 || []).map(l => l.id);
        if (leadIds.length) {
          await supabaseAdmin.from('nudge_queue')
            .update({ failed_reason: 'opted_out' })
            .in('lead_id', leadIds)
            .is('sent_at', null)
            .is('failed_reason', null);
        }
      } catch { /* nudge_queue may not exist in some envs */ }

      reply = 'You have been unsubscribed and will no longer receive messages. Reply START to resubscribe.';
    } else if (upper === 'START' || upper === 'UNSTOP') {
      // Mirror the resubscribe across contact + matching leads.
      // Removes 'Do Not Contact' from tags too so the operator sees
      // them re-eligible for future campaigns.
      const stripDNC = (tags) => (tags || []).filter(t => t !== 'Do Not Contact');
      await supabaseAdmin.from('contacts')
        .update({ opted_out: false, tags: stripDNC(contact.tags) })
        .eq('id', contact.id);
      try {
        const { data: matchingLeads } = await supabaseAdmin
          .from('leads').select('id, tags')
          .eq('client_id', client.id).eq('phone', from);
        for (const ld of (matchingLeads || [])) {
          await supabaseAdmin.from('leads')
            .update({ opted_out: false, tags: stripDNC(ld.tags) })
            .eq('id', ld.id);
        }
      } catch { /* opted_out column missing — non-fatal */ }
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

    await insertInboundMessage({
      client_id: client.id, contact_id: contact.id, lead_id: leadId,
      direction: 'inbound',
      body, segments: estimateSegments(body), twilio_sid: sid,
      status: 'received', to_number: to, from_number: from,
      media_url: inboundMediaUrl,
      is_mms: isMms
    });

    // Push notification for inbound SMS (skip TCPA keyword replies).
    // MMS gets a distinct 📷 icon so the operator knows to open the
    // thread to view the image, not just skim the notification.
    if (!reply) {
      const senderName = contact?.name && contact.name !== from ? contact.name : from;
      const bodyPreview = body.length > 80 ? body.slice(0, 80) + '…' : body;
      const smsDesc = isMms
        ? `${senderName} sent a photo${body ? ': ' + bodyPreview : ''}`
        : `${senderName}: ${bodyPreview}`;
      const icon = isMms ? '📷' : '💬';
      const label = isMms ? 'MMS' : 'SMS';
      await Promise.all([
        sendPushToClient(client.id, `${icon} New ${label} Reply`, smsDesc, '/messages').catch(() => {}),
        sendPushToAdmins(`${icon} ${label} — ` + (client.name || to), smsDesc, '/messages').catch(() => {})
      ]);
    }

    // STOP/START/HELP are TCPA-required responses — return them directly
    // instead of forwarding to Vapi, since compliance takes priority.
    if (reply) {
      // Truncate even though TCPA replies are short — the validation
      // rule applies to every outbound SMS regardless of source.
      reply = truncateForSms(reply);
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

    // ── Keyword fast-path ─────────────────────────────────────────
    // Before handing off to Vapi, check whether the incoming message
    // is an exact match for a per-tenant artist keyword (e.g. texting
    // "Leslie" to iSlay Studios' number). If so, reply immediately
    // with that artist's welcome + booking link and skip the AI
    // concierge. Falls through untouched when nothing matches so the
    // existing Vapi conversation flow keeps handling free-form text.
    //
    // Matching rules (per product spec):
    //   - normalize = body.trim().toLowerCase()
    //   - exact match against the ENTIRE body (not "contains") so
    //     ambiguous text like "Leslie tomorrow?" falls through to AI
    //   - skip when contact.opted_out is true (TCPA — don't message
    //     unsubscribed recipients even on inbound-triggered replies)
    if (!contact?.opted_out) {
      const normalized = body.trim().toLowerCase();
      if (normalized) {
        const { data: kwRows } = await supabaseAdmin
          .from('artist_sms_keywords')
          .select('artist_name, role, booking_url, welcome_message, booking_type, keywords')
          .eq('client_id', client.id)
          .eq('active', true);
        const match = (kwRows || []).find(row =>
          Array.isArray(row.keywords) &&
          row.keywords.some(k => String(k || '').trim().toLowerCase() === normalized)
        );
        if (match) {
          const actionPhrase = match.booking_type === 'message'
            ? 'Message us here to book'
            : 'Grab your spot here';
          const rolePart = match.role ? `, our ${match.role}` : '';
          const businessName = client.name || 'the studio';
          const kwReply = match.welcome_message
            || `Hey! You've reached ${businessName} 👑 You're all set to book with ${match.artist_name}${rolePart}. ${actionPhrase}:\n${match.booking_url}\n\nReply STOP to opt out.`;

          // Log the outbound so it threads correctly in the portal
          // Messages tab. NOTE: deliberately skips truncateForSms —
          // the booking URL has to survive intact even if that means
          // Twilio bills an extra segment.
          await supabaseAdmin.from('messages').insert({
            client_id: client.id,
            contact_id: contact?.id || null,
            lead_id: leadId,
            direction: 'outbound',
            body: kwReply,
            segments: estimateSegments(kwReply),
            status: 'sent',
            to_number: from,
            from_number: to
          });

          // Best-effort lead capture for CRM visibility. Non-fatal —
          // a failed insert here shouldn't prevent the customer from
          // getting their reply.
          try {
            await supabaseAdmin.from('leads').insert({
              client_id:       client.id,
              phone:           from,
              name:            (contact?.name && contact.name !== from) ? contact.name : null,
              artist_selected: match.artist_name,
              booking_url:     match.booking_url,
              source:          'sms_keyword',
              lead_source:     'sms_keyword',
              lead_status:     'New'
            });
          } catch (e) {
            console.error('[twilio/inbound] sms_keyword lead insert failed:', e.message);
          }

          const encodeXml = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
          res.setHeader('Content-Type', 'text/xml');
          return res
            .status(200)
            .send(`<Response><Message>${encodeXml(kwReply)}</Message></Response>`);
        }
      }
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
      // This is AI-generated SMS content (Vapi's assistant). Apply
      // the same 160-char ceiling we enforce on every other outbound
      // path. Decode TwiML entities → truncate → re-encode → rewrite
      // the TwiML body before forwarding to Twilio so the customer
      // sees the truncated version.
      let outboundTwiml = vapiTwiml;
      if (msgMatch && msgMatch[1]) {
        const decodeXml = (s) => String(s)
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        const encodeXml = (s) => String(s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
        const decoded = decodeXml(msgMatch[1]).trim();
        const truncated = truncateForSms(decoded);
        if (truncated !== decoded) {
          outboundTwiml = vapiTwiml.replace(
            /<Message(\s[^>]*)?>[\s\S]*?<\/Message>/i,
            (_full, attrs) => `<Message${attrs || ''}>${encodeXml(truncated)}</Message>`
          );
        }
        if (truncated) {
          await supabaseAdmin.from('messages').insert({
            client_id: client.id,
            contact_id: contact?.id || null,
            lead_id: leadId,
            direction: 'outbound',
            body: truncated,
            segments: estimateSegments(truncated),
            status: 'sent',
            to_number: from,
            from_number: to
          });
        }
      }

      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(outboundTwiml);
    } catch (err) {
      console.error('[twilio/inbound] Vapi forward failed:', err.message);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response></Response>');
    }
  }

  return res.status(400).json({ error: 'unknown_action' });
}
