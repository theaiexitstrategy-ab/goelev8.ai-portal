// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Portal → Google Calendar mirror. When an experience_bookings row
// flips to 'confirmed' via the Stripe webhook we mirror it as an
// event on the tenant's connected calendar. On refund / cancel we
// delete the mirror. Every call is best-effort — a Google outage
// never blocks the DB write. Idempotent via
// experience_bookings.google_event_id.

import { supabaseAdmin } from './supabase.js';
import { loadTenantTokens, insertEvent, updateEvent, deleteEvent } from './gcal.js';

function fmtSummary(booking) {
  const parts = [
    'Booked: ' + (booking.experience_display || 'Experience'),
    booking.guest_name ? '— ' + booking.guest_name : null,
    booking.guest_count ? `(${booking.guest_count} guests)` : null
  ].filter(Boolean);
  return parts.join(' ');
}

function fmtDescription(booking) {
  const lines = [
    booking.guest_name  ? `Guest: ${booking.guest_name}` : null,
    booking.guest_email ? `Email: ${booking.guest_email}` : null,
    booking.guest_phone ? `Phone: ${booking.guest_phone}` : null,
    booking.guest_count ? `Guests: ${booking.guest_count}` : null,
    booking.goal        ? `\nNotes:\n${booking.goal}` : null,
    booking.deposit_cents ? `\nDeposit paid: $${(booking.deposit_cents/100).toFixed(2)}` : null,
    `\nView in portal: https://portal.goelev8.ai/?tab=experience_bookings`
  ].filter(Boolean);
  return lines.join('\n');
}

export async function writeBookingToGoogleCalendar({ bookingId }) {
  if (!bookingId) return { ok: false, error: 'booking_id_required' };
  const { data: booking } = await supabaseAdmin
    .from('experience_bookings').select('*').eq('id', bookingId).maybeSingle();
  if (!booking) return { ok: false, error: 'booking_not_found' };
  if (!booking.event_starts_at) return { ok: false, error: 'no_event_starts_at' };

  // Load tenant's GCal link (may not exist → nothing to do).
  let t;
  try { t = await loadTenantTokens(booking.client_id); }
  catch (e) {
    // 'cgc_not_connected' is a valid state — tenant hasn't set up
    // Google Calendar sync. Silent no-op.
    if (/not_connected|tokens_missing/.test(e.message)) return { ok: true, skipped: 'not_connected' };
    throw e;
  }
  const calId = t.calendar_id || 'primary';

  const startsAt = new Date(booking.event_starts_at).toISOString();
  const durationMin = booking.duration_min || 120;
  const endsAt = new Date(new Date(startsAt).getTime() + durationMin * 60_000).toISOString();

  const eventPayload = {
    summary:     fmtSummary(booking),
    description: fmtDescription(booking),
    start:       { dateTime: startsAt, timeZone: booking.event_tz || t.calendar_id === 'primary' ? 'America/Chicago' : undefined },
    end:         { dateTime: endsAt,   timeZone: booking.event_tz || 'America/Chicago' },
    // Mark this event as busy on Google's calendar so nothing else
    // can accidentally overlap. Also propagates through Google's
    // free/busy API to other calendars sharing the account.
    transparency: 'opaque',
    // Store the booking id in extendedProperties so we can trace back
    // to our row without pattern-matching the summary.
    extendedProperties: {
      private: {
        goelev8_source: 'experience_booking',
        goelev8_booking_id: String(booking.id)
      }
    }
  };

  // Idempotent — update if we already have a google_event_id,
  // otherwise insert.
  let ev;
  try {
    if (booking.google_event_id) {
      ev = await updateEvent(t.access_token, calId, booking.google_event_id, eventPayload);
    } else {
      ev = await insertEvent(t.access_token, calId, eventPayload);
    }
  } catch (e) {
    // If update fails with 404 the event was deleted on Google's side
    // — recover by inserting a fresh one.
    if (e.status === 404 && booking.google_event_id) {
      ev = await insertEvent(t.access_token, calId, eventPayload);
    } else {
      throw e;
    }
  }

  if (ev?.id) {
    await supabaseAdmin.from('experience_bookings').update({
      google_event_id:    ev.id,
      google_calendar_id: calId,
      updated_at:         new Date().toISOString()
    }).eq('id', booking.id);
  }
  return { ok: true, event_id: ev?.id };
}

export async function deleteBookingFromGoogleCalendar({ bookingId }) {
  if (!bookingId) return { ok: false, error: 'booking_id_required' };
  const { data: booking } = await supabaseAdmin
    .from('experience_bookings').select('id, client_id, google_event_id, google_calendar_id').eq('id', bookingId).maybeSingle();
  if (!booking || !booking.google_event_id) return { ok: true, skipped: 'no_google_event' };
  let t;
  try { t = await loadTenantTokens(booking.client_id); }
  catch (e) {
    if (/not_connected|tokens_missing/.test(e.message)) return { ok: true, skipped: 'not_connected' };
    throw e;
  }
  const calId = booking.google_calendar_id || t.calendar_id || 'primary';
  await deleteEvent(t.access_token, calId, booking.google_event_id);
  await supabaseAdmin.from('experience_bookings').update({
    google_event_id: null, updated_at: new Date().toISOString()
  }).eq('id', booking.id);
  return { ok: true };
}
