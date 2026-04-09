// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// iSlay Studios SMS helpers — booking confirmations and inquiry notifications.
// Uses the same credit/Twilio infrastructure as the welcome SMS flow.

import { supabaseAdmin } from './supabase.js';
import { twilioForClient, estimateSegments } from './twilio.js';

// SMS deduplication: don't send to the same phone within 24 hours for the
// same client. Mirrors the dedup logic used by Flex Facility welcome SMS.
async function recentlySent(clientId, phone, reason) {
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

async function sendSms({ client, to, body }) {
  if (!client?.twilio_phone_number) return { sent: false, reason: 'no_twilio_number' };
  if (!to || !/^\+?\d[\d\s\-().]{6,}$/.test(to)) return { sent: false, reason: 'invalid_phone' };

  const segments = estimateSegments(body);
  if ((client.credit_balance ?? 0) < segments) {
    return { sent: false, reason: 'insufficient_credits' };
  }

  // Atomic deduct
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
    // Refund on failure
    await supabaseAdmin.rpc('add_credits', { p_client_id: client.id, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: client.id, delta: segments, reason: 'refund', ref_id: 'islay_sms_failed'
    });
    return { sent: false, reason: 'twilio_failed: ' + err.message };
  }

  // Find or create contact for threading
  let contactId = null;
  const { data: existing } = await supabaseAdmin
    .from('contacts').select('id').eq('client_id', client.id).eq('phone', to).maybeSingle();
  if (existing) {
    contactId = existing.id;
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
    client_id: client.id, delta: -segments, reason: 'islay_sms', ref_id: twilioMsg.sid
  });

  return { sent: true, sid: twilioMsg.sid, segments };
}

// Send booking confirmation SMS to artist
export async function sendArtistBookingSms({ client, booking }) {
  if (!booking.phone) return { sent: false, reason: 'no_phone' };

  const dedup = await recentlySent(client.id, booking.phone, 'booking_confirm');
  if (dedup) return { sent: false, reason: 'dedup_24h' };

  const date = new Date(booking.session_date);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const body = `Hey ${booking.artist_name}! Your session at iSlay Studios is confirmed for ${dateStr} at ${timeStr}. Questions? Reply to this message 🎤`;

  return sendSms({ client, to: booking.phone, body });
}

// Send inquiry welcome SMS to artist
export async function sendArtistInquirySms({ client, inquiry }) {
  if (!inquiry.artist_phone) return { sent: false, reason: 'no_phone' };

  const dedup = await recentlySent(client.id, inquiry.artist_phone, 'inquiry_welcome');
  if (dedup) return { sent: false, reason: 'dedup_24h' };

  const body = `Hey ${inquiry.artist_name}! 🎤 Thanks for reaching out to iSlay Studios! We'll be in touch shortly to set up your session. Check us out: islaystudiosllc.com`;

  return sendSms({ client, to: inquiry.artist_phone, body });
}

// Notify iSlay Studios owner about new inquiry
export async function notifyOwnerNewInquiry({ client, inquiry }) {
  // Get the owner's phone from the client's Twilio number — we send TO
  // the Twilio number as a self-notification. In practice, the owner
  // would configure a notification phone. For now, we use a simpler approach:
  // look up client_users with role 'owner' and check if they have a lead
  // with their phone in the system. This is best-effort.
  const portalUrl = process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai';
  const body = `New artist inquiry!\nName: ${inquiry.artist_name}\nPhone: ${inquiry.artist_phone || 'N/A'}\nInterest: ${inquiry.service_interest || 'N/A'}\nView in portal: ${portalUrl}`;

  // For owner notification, we use the OWNER_NOTIFY_PHONE env var if set,
  // otherwise skip (owner sees it in the portal dashboard).
  const ownerPhone = process.env.ISLAY_OWNER_PHONE;
  if (!ownerPhone) return { sent: false, reason: 'no_owner_phone_configured' };

  return sendSms({ client, to: ownerPhone, body });
}
