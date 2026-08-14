// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Confirmations for a paid event seat. SMS only for now, per the operator
// — email is deliberately deferred, but event_reservations already has a
// confirmation_email_sent_at column so adding it later needs no migration.
//
// Idempotency: guarded on event_reservations.confirmation_sent_at /
// .tenant_alert_sent_at, the same shape as lib/experience-notify.js.
// Stripe delivers at-least-once, so without this a redelivery texts the
// attendee twice. Rows mirrored from the marketing site are stamped with
// both columns at ingest (see lib/event-ingest.js) precisely so this
// helper skips them — that site already sent its own confirmations.
//
// Sends are best-effort and never throw into the webhook handler: a
// reservation must stay recorded even if Twilio is down.
//
// SMS LENGTH — read before editing the body copy. lib/twilio.js caps
// outbound at 160 chars and truncateForSms() cuts at a word boundary with
// no ellipsis. A raw Stripe receipt_url runs 120+ characters, so putting
// one in the body would silently eat the whole message and leave the
// recipient a dead half-link. That's why the receipt goes out as a short
// /r/:token redirect instead (api/receipt.js), which keeps the whole
// message inside one GSM-7 segment = one credit.

import { supabaseAdmin } from './supabase.js';
import { twilio, truncateForSms } from './twilio.js';
import { sendTransactionalSms } from './transactional-sms.js';

function fmtWhen(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'America/Chicago',
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    }).format(new Date(iso));
  } catch { return iso; }
}

function portalBase() {
  return (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
}

export async function notifyEventReservationConfirmed({ reservationId }) {
  if (!reservationId) return { ok: false, error: 'reservation_id_required' };

  // Re-fetch rather than trusting a passed row so the idempotency columns
  // are read fresh — two concurrent webhook deliveries must not both see
  // a null confirmation_sent_at.
  const { data: r } = await supabaseAdmin
    .from('event_reservations').select('*').eq('id', reservationId).maybeSingle();
  if (!r) return { ok: false, error: 'reservation_not_found' };

  const { data: ev } = await supabaseAdmin
    .from('tenant_events')
    .select('title, starts_at, event_tz, location_name, address_line1, city, state')
    .eq('id', r.event_id).maybeSingle();

  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, business_name, credit_balance, twilio_subaccount_sid, twilio_auth_token, twilio_phone_number, owner_phone, owner_email')
    .eq('id', r.client_id).maybeSingle();
  if (!client) return { ok: false, error: 'tenant_not_found' };

  const bizName = client.business_name || client.name || 'the team';
  const title   = ev?.title || 'your event';
  const whenStr = ev?.starts_at ? fmtWhen(ev.starts_at, ev.event_tz) : '';
  const results = { guest_sms: null, tenant_sms: null };

  // ── Attendee ───────────────────────────────────────────────────
  if (!r.confirmation_sent_at) {
    if (r.attendee_phone) {
      const receiptLink = r.receipt_token ? `${portalBase()}/r/${r.receipt_token}` : null;
      // Kept deliberately terse so the link survives the 160-char cap.
      const body = [
        `${bizName}: You're in for ${title}`,
        whenStr ? ` — ${whenStr}` : '',
        '.',
        receiptLink ? ` Receipt: ${receiptLink}` : '',
        ' Reply STOP to opt out.'
      ].join('');
      try {
        const sent = await sendTransactionalSms({
          client,
          to: r.attendee_phone,
          body,
          ledgerReason: 'event_confirmation_sms',
          refId: r.stripe_payment_intent || r.stripe_session_id || undefined
        });
        results.guest_sms = sent.sent ? 'sent' : `skipped:${sent.reason}`;
      } catch (e) { results.guest_sms = `error:${e?.message || e}`; }
    } else {
      results.guest_sms = 'skipped_no_phone';
    }
    // Stamped after attempting, so a transient Twilio outage doesn't put
    // us in an infinite retry loop on every webhook redelivery. At-most-once
    // is the deliberate trade — same call lib/experience-notify.js makes.
    await supabaseAdmin.from('event_reservations')
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq('id', r.id);
  }

  // ── Tenant alert ───────────────────────────────────────────────
  if (!r.tenant_alert_sent_at) {
    const to = client.owner_phone || null;
    const from = client.twilio_phone_number || process.env.TWILIO_DEFAULT_FROM;
    if (to && from) {
      try {
        await twilio.messages.create({
          from,
          to,
          body: truncateForSms(
            `New signup: ${title}${whenStr ? ` (${whenStr})` : ''} — ${r.attendee_name || 'Attendee'}`
            + `${r.attendee_phone ? ` ${r.attendee_phone}` : ''}`
          )
        });
        results.tenant_sms = 'sent';
      } catch (e) { results.tenant_sms = `error:${e?.message || e}`; }
    } else {
      results.tenant_sms = 'skipped_no_number';
    }
    await supabaseAdmin.from('event_reservations')
      .update({ tenant_alert_sent_at: new Date().toISOString() })
      .eq('id', r.id);
  }

  return { ok: true, results };
}
