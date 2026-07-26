// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Sends notifications when an experience booking is confirmed:
//   1. Guest confirmation — SMS + email
//   2. Tenant alert       — SMS + email to Stephen (Konquered Balance
//                            owner) / whichever tenant owner
//
// Idempotency: guarded on experience_bookings.confirmation_sent_at and
// .tenant_alert_sent_at. Stripe delivers webhooks with at-least-once
// semantics, so double-fires would otherwise ping Stephen twice.
//
// Sends are best-effort. Failure on one channel does NOT block the
// other. All failures are logged but never thrown to the webhook
// handler (booking status must still commit even if email/SMS is
// down).

import { supabaseAdmin } from './supabase.js';
import { twilio, twilioForClient, truncateForSms } from './twilio.js';
import { sendMail } from './mailer.js';

function fmtMoney(cents) {
  if (!Number.isFinite(cents)) return '';
  return `$${(cents / 100).toFixed(2)}`;
}

// Format an ISO datetime into a human-friendly local string in the
// event's timezone. We accept the tenant's tz because guests booking
// KB experiences are usually local — showing them "Sat, Jul 26 at
// 7:00 PM" (their time) is what they expect.
function fmtWhen(iso, tz) {
  try {
    const d = new Date(iso);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(d);
  } catch { return iso; }
}

export async function notifyExperienceConfirmed({ bookingId }) {
  if (!bookingId) return { ok: false, error: 'booking_id_required' };

  // Load booking + tenant. We fetch fresh (rather than trusting a passed
  // row) so idempotency checks see up-to-date sent_at columns.
  const { data: booking, error: bookingErr } = await supabaseAdmin
    .from('experience_bookings')
    .select('*')
    .eq('id', bookingId)
    .maybeSingle();
  if (bookingErr || !booking) return { ok: false, error: 'booking_not_found' };

  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, business_name, twilio_subaccount_sid, twilio_auth_token, twilio_phone_number, owner_phone, owner_email')
    .eq('id', booking.client_id)
    .maybeSingle();
  if (!client) return { ok: false, error: 'tenant_not_found' };

  const bizName = client.business_name || client.name || 'the team';
  const whenStr = fmtWhen(booking.event_starts_at, booking.event_tz);
  const displayName = booking.experience_display || 'your experience';
  const depositStr = fmtMoney(booking.deposit_cents);

  const results = { guest_sms: null, guest_email: null, tenant_sms: null, tenant_email: null };

  // ── Guest side ─────────────────────────────────────────────────
  if (!booking.confirmation_sent_at) {
    // SMS
    if (booking.guest_phone) {
      try {
        const from = client.twilio_phone_number || process.env.TWILIO_DEFAULT_FROM;
        if (from) {
          const twClient = twilioForClient(client);
          const body = truncateForSms(
            `${bizName}: Deposit received${depositStr ? ` (${depositStr})` : ''}. You're booked for ${displayName} on ${whenStr}. Reply STOP to opt out.`
          );
          await twClient.messages.create({ from, to: booking.guest_phone, body });
          results.guest_sms = 'sent';
        } else {
          results.guest_sms = 'skipped_no_from';
        }
      } catch (e) { results.guest_sms = `error:${e?.message || e}`; }
    }
    // Email
    if (booking.guest_email) {
      try {
        const subject = `You're booked — ${displayName} on ${whenStr}`;
        const html = `
          <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5;">
            <h2 style="margin:0 0 12px;">You're booked with ${bizName}!</h2>
            <p>Thanks ${booking.guest_name || ''} — your deposit of <strong>${depositStr}</strong> has been received.</p>
            <table style="border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:6px 12px 6px 0;color:#666;">Experience</td><td style="padding:6px 0;"><strong>${displayName}</strong></td></tr>
              <tr><td style="padding:6px 12px 6px 0;color:#666;">When</td><td style="padding:6px 0;"><strong>${whenStr}</strong></td></tr>
              ${booking.guest_count ? `<tr><td style="padding:6px 12px 6px 0;color:#666;">Guests</td><td style="padding:6px 0;"><strong>${booking.guest_count}</strong></td></tr>` : ''}
              ${booking.duration_min ? `<tr><td style="padding:6px 12px 6px 0;color:#666;">Duration</td><td style="padding:6px 0;"><strong>${booking.duration_min} min</strong></td></tr>` : ''}
            </table>
            <p>${bizName} will reach out with any final details before your event. If you need to reschedule or cancel, just reply to this email.</p>
            <p style="color:#888;font-size:12px;margin-top:24px;">This confirmation was sent from ${bizName} via GoElev8.ai.</p>
          </div>`;
        await sendMail({ to: booking.guest_email, subject, html });
        results.guest_email = 'sent';
      } catch (e) { results.guest_email = `error:${e?.message || e}`; }
    }
    // Mark idempotency AFTER attempting both channels so a partial
    // failure still records the send attempt (we prefer at-most-once
    // per channel over infinite retries on transient failures).
    await supabaseAdmin.from('experience_bookings')
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq('id', booking.id);
  }

  // ── Tenant side ────────────────────────────────────────────────
  if (!booking.tenant_alert_sent_at) {
    const tenantPhone = client.owner_phone || null;
    const tenantEmail = client.owner_email || null;
    const guestLine = [
      booking.guest_name,
      booking.guest_phone,
      booking.guest_email
    ].filter(Boolean).join(' · ');

    if (tenantPhone) {
      try {
        const from = client.twilio_phone_number || process.env.TWILIO_DEFAULT_FROM;
        if (from) {
          const body = truncateForSms(
            `New booking: ${displayName} on ${whenStr} — ${booking.guest_name || 'Guest'}${booking.guest_phone ? ` (${booking.guest_phone})` : ''}${depositStr ? ` · ${depositStr} deposit` : ''}`
          );
          await twilio.messages.create({ from, to: tenantPhone, body });
          results.tenant_sms = 'sent';
        }
      } catch (e) { results.tenant_sms = `error:${e?.message || e}`; }
    }
    if (tenantEmail) {
      try {
        const subject = `[${bizName}] New booking — ${displayName} on ${whenStr}`;
        const html = `
          <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5;">
            <h2 style="margin:0 0 12px;">New booking confirmed</h2>
            <table style="border-collapse:collapse;">
              <tr><td style="padding:4px 12px 4px 0;color:#666;">Experience</td><td style="padding:4px 0;"><strong>${displayName}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#666;">When</td><td style="padding:4px 0;"><strong>${whenStr}</strong></td></tr>
              ${booking.guest_count ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Guests</td><td style="padding:4px 0;"><strong>${booking.guest_count}</strong></td></tr>` : ''}
              <tr><td style="padding:4px 12px 4px 0;color:#666;">Guest</td><td style="padding:4px 0;">${guestLine || '—'}</td></tr>
              ${depositStr ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Deposit</td><td style="padding:4px 0;"><strong>${depositStr}</strong></td></tr>` : ''}
              ${booking.goal ? `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top;">Notes</td><td style="padding:4px 0;">${String(booking.goal).replace(/</g, '&lt;')}</td></tr>` : ''}
            </table>
            <p style="color:#888;font-size:12px;margin-top:20px;">View in portal → <a href="https://portal.goelev8.ai/?tab=experience_bookings">experience_bookings tab</a></p>
          </div>`;
        await sendMail({ to: tenantEmail, subject, html });
        results.tenant_email = 'sent';
      } catch (e) { results.tenant_email = `error:${e?.message || e}`; }
    }
    await supabaseAdmin.from('experience_bookings')
      .update({ tenant_alert_sent_at: new Date().toISOString() })
      .eq('id', booking.id);
  }

  return { ok: true, results };
}
