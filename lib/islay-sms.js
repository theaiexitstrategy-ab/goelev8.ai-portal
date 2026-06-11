// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// iSlay Studios SMS helpers — booking confirmations and inquiry notifications.
// Shares the credit + Twilio + ledger plumbing with all other portal
// transactional SMS via lib/transactional-sms.js.

import { supabaseAdmin } from './supabase.js';
import { sendTransactionalSms, recentlySent } from './transactional-sms.js';

// Thin wrapper so the call sites in this file stay readable.
function sendSms({ client, to, body }) {
  return sendTransactionalSms({ client, to, body, ledgerReason: 'islay_sms' });
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
