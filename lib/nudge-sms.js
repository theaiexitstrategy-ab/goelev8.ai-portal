// Nudge SMS sequence: query the nudge_sequences table for a business,
// replace merge tags, and schedule each message using delay_minutes.
//
// Called from api/events.js when a new lead comes in. Each message is
// sent after its configured delay by scheduling a setTimeout on the
// serverless invocation. For production, consider moving to a Supabase
// pg_cron job or a proper queue — but for Vercel serverless the
// fire-and-forget setTimeout approach works for delays up to ~10 min.
// Longer delays are handled by a scheduled cron endpoint.

import { supabaseAdmin } from './supabase.js';
import { twilioForClient, estimateSegments } from './twilio.js';
import { toE164 } from './phone.js';

// ── Merge tag replacement ───────────────────────────────────────────

function replaceMergeTags(template, vars) {
  return String(template || '')
    .replace(/\[first_name\]/gi, vars.first_name || '')
    .replace(/\[business_name\]/gi, vars.business_name || '')
    .replace(/\[funnel_url\]/gi, vars.funnel_url || '')
    .replace(/\[phone\]/gi, vars.phone || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstName(full) {
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0] || '';
}

// ── Default templates (fallback if no rows in DB) ───────────────────

const DEFAULT_NUDGES = [
  { message_number: 1, message_body: 'Hey [first_name]! [business_name] here. We just got your info \u2014 someone will follow up shortly. Reply STOP to opt out.', delay_minutes: 0, is_active: true },
  { message_number: 2, message_body: 'Still thinking it over? [business_name] is ready when you are. Check out what we offer: [funnel_url]', delay_minutes: 60, is_active: true },
  { message_number: 3, message_body: 'Hey [first_name], just checking in. Spots fill up fast at [business_name]. Want to lock yours in?', delay_minutes: 1440, is_active: true },
  { message_number: 4, message_body: 'Last thing \u2014 [business_name] wanted to make sure you didn\u2019t miss out. Reply back anytime.', delay_minutes: 2880, is_active: true },
  { message_number: 5, message_body: 'We\u2019ll leave the door open. Come back when you\u2019re ready: [funnel_url]', delay_minutes: 4320, is_active: true }
];

// ── Send a single nudge message ─────────────────────────────────────

async function sendOneNudge({ client, contactId, leadId, to, text, messageNumber }) {
  const segments = estimateSegments(text);
  if ((client.credit_balance ?? 0) < segments) {
    return { sent: false, reason: 'insufficient_credits', message_number: messageNumber };
  }

  // Atomic deduct
  const { error: dErr } = await supabaseAdmin
    .rpc('consume_credits', { p_client_id: client.id, p_amount: segments });
  if (dErr) return { sent: false, reason: 'consume_failed', message_number: messageNumber };

  // Re-check balance (consume_credits updates credit_balance in place)
  const { data: freshClient } = await supabaseAdmin
    .from('clients').select('credit_balance').eq('id', client.id).single();
  if (freshClient) client.credit_balance = freshClient.credit_balance;

  const tw = twilioForClient(client);
  let twilioMsg;
  try {
    twilioMsg = await tw.messages.create({
      from: client.twilio_phone_number,
      to,
      body: text,
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
    });
  } catch (err) {
    // Refund on hard failure
    await supabaseAdmin.rpc('add_credits', { p_client_id: client.id, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: client.id, delta: segments, reason: 'refund', ref_id: `nudge_${messageNumber}_failed`
    });
    return { sent: false, reason: 'twilio_failed: ' + err.message, message_number: messageNumber };
  }

  // Log message + ledger
  await supabaseAdmin.from('messages').insert({
    client_id: client.id,
    contact_id: contactId,
    lead_id: leadId || null,
    direction: 'outbound',
    body: text,
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: to,
    from_number: client.twilio_phone_number,
    credits_charged: segments
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id: client.id, delta: -segments, reason: 'nudge_sms', ref_id: twilioMsg.sid
  });

  return { sent: true, sid: twilioMsg.sid, message_number: messageNumber, segments };
}

// ── Schedule the full nudge sequence for a lead ─────────────────────
//
// Fires message 1 immediately (delay_minutes = 0), then schedules the
// rest. For delays > 10 minutes we persist a `nudge_queue` record that
// a cron job picks up. For short delays (<=10 min) we use setTimeout
// within the serverless invocation window.
//
// Returns the result for message 1 only (the rest are fire-and-forget).

export async function scheduleNudgeSequence({ client, lead }) {
  if (!client?.twilio_phone_number) return { sent: false, reason: 'no_twilio_number' };

  // Normalize to E.164 — Twilio rejects bare 10-digit numbers like
  // "5572196896" with status=undelivered.
  const to = toE164(lead.phone);
  if (!to) return { sent: false, reason: 'no_valid_phone' };

  const leadId = lead.id || null;

  // Check opt-out
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('id, opted_out')
    .eq('client_id', client.id)
    .eq('phone', to)
    .maybeSingle();

  if (contact?.opted_out) return { sent: false, reason: 'opted_out' };

  // Find or create contact
  let contactId = contact?.id || null;
  if (!contactId) {
    const { data: created } = await supabaseAdmin
      .from('contacts')
      .insert({
        client_id: client.id,
        phone: to,
        name: lead.name || null,
        email: lead.email || null,
        source: lead.source || null
      })
      .select('id')
      .single();
    contactId = created?.id || null;
  }

  // Load nudge sequences for this business
  const { data: nudges } = await supabaseAdmin
    .from('nudge_sequences')
    .select('*')
    .eq('client_id', client.id)
    .order('message_number', { ascending: true });

  const sequence = nudges?.length ? nudges : DEFAULT_NUDGES;

  // Build merge-tag variables
  const funnelSlug = client.slug || '';
  const vars = {
    first_name: firstName(lead.name),
    business_name: client.business_name || client.name || '',
    funnel_url: funnelSlug ? `https://goelev8.ai/f/${funnelSlug}` : '',
    phone: to
  };

  let firstResult = { sent: false, reason: 'no_active_messages' };

  for (const nudge of sequence) {
    if (!nudge.is_active) continue;

    const text = replaceMergeTags(nudge.message_body, vars);
    if (!text) continue;

    const delayMs = (nudge.delay_minutes || 0) * 60 * 1000;

    if (delayMs === 0) {
      // Message 1 — send immediately
      firstResult = await sendOneNudge({
        client, contactId, leadId, to, text,
        messageNumber: nudge.message_number
      });
    } else if (delayMs <= 600_000) {
      // <= 10 minutes — schedule in-process (fire-and-forget)
      setTimeout(async () => {
        try {
          // Re-check opt-out before sending delayed message
          const { data: c } = await supabaseAdmin
            .from('contacts').select('opted_out').eq('id', contactId).maybeSingle();
          if (c?.opted_out) return;

          // Reload client for fresh balance
          const { data: freshClient } = await supabaseAdmin
            .from('clients').select('*').eq('id', client.id).single();
          if (!freshClient) return;

          await sendOneNudge({
            client: freshClient, contactId, leadId, to, text,
            messageNumber: nudge.message_number
          });
        } catch (e) {
          console.error(`[nudge] msg ${nudge.message_number} failed:`, e.message);
        }
      }, delayMs);
    } else {
      // > 10 minutes — persist to nudge_queue for cron pickup.
      // The scheduled_for timestamp lets a cron job (e.g. Supabase pg_cron
      // or a Vercel cron) poll for due messages and send them. The lead_id
      // is carried so the cron worker can persist it onto the messages
      // row when it eventually fires the send.
      await supabaseAdmin.from('nudge_queue').insert({
        client_id: client.id,
        contact_id: contactId,
        lead_id: leadId,
        to_number: to,
        message_body: text,
        message_number: nudge.message_number,
        scheduled_for: new Date(Date.now() + delayMs).toISOString()
      }).then(() => {}).catch((e) => {
        console.error(`[nudge] queue insert msg ${nudge.message_number}:`, e.message);
      });
    }
  }

  return firstResult;
}
