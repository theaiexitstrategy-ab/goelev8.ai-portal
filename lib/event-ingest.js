// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Gets paid event seats into public.event_reservations. Two callers, two
// very different situations:
//
//  1. confirmEventReservation() — the go-forward path. The portal created
//     the Checkout Session itself (api/external/event-reservations.js,
//     source='event_reservation'), so a pending row already exists and we
//     just promote it and fire the confirmation.
//
//  2. ingestLegacyEventSession() — the RIGHT NOW path. theflexfacility.com
//     is selling bootcamp seats today through its own api/bootcamp.js.
//     The key insight that makes this work with zero changes to the
//     marketing site: that site holds a RESTRICTED KEY BELONGING TO THE
//     GOELEV8 PLATFORM ACCOUNT and creates DESTINATION charges
//     (transfer_data.destination → the tenant's connected account). So
//     those Checkout Sessions live on OUR platform account. The portal's
//     own Stripe credentials can already see every one of them — via the
//     platform webhook and via checkout.sessions.list — without the tenant
//     deploying anything.
//
//     That means payments reflect in the portal before the cutover, not
//     after it.
//
// IMPORTANT — no duplicate notifications on the legacy path. The
// marketing site already emails (ForwardEmail) and texts (Twilio) every
// one of those buyers. Ingesting a mirror row must not text them a second
// time, so legacy rows are stamped confirmation_sent_at at insert. That
// permanently closes the door: lib/event-notify.js skips anything with
// that column set, so a later replay or backfill can't reopen it.

import { createHash } from 'node:crypto';
import { stripe } from './stripe.js';
import { supabaseAdmin } from './supabase.js';
import { toE164 } from './phone.js';
import { quoteEventSeat, resolvePlatformFeePct } from './platform-fee.js';

// Marker the portal stamps on its own sessions. Anything carrying it is
// handled by confirmEventReservation, never by the legacy matcher.
export const EVENT_SOURCE_MARKER = 'event_reservation';

export function sha256Hex(s) {
  return createHash('sha256').update(String(s == null ? '' : s)).digest('hex');
}

// Pull the charge behind a session so we can store a receipt link. Legacy
// bootcamp charges are destination charges on the PLATFORM account, so
// they're retrieved with no stripeAccount scope; portal direct charges
// live on the connected account and need it. Best-effort in both cases —
// a missing receipt must never block recording the payment.
async function loadCharge(session, connectAccount) {
  const piId = typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent?.id;
  if (!piId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(
      piId,
      { expand: ['latest_charge'] },
      connectAccount ? { stripeAccount: connectAccount } : undefined
    );
    const charge = pi?.latest_charge && typeof pi.latest_charge === 'object'
      ? pi.latest_charge
      : null;
    return {
      payment_intent: piId,
      charge_id:      charge?.id || null,
      receipt_url:    charge?.receipt_url || null,
      transfer_destination: pi?.transfer_data?.destination || null
    };
  } catch (e) {
    console.warn('[event-ingest] charge lookup failed:', e?.message);
    return { payment_intent: piId, charge_id: null, receipt_url: null, transfer_destination: null };
  }
}

// ── 1. Go-forward: promote the portal's own pending reservation ──────
//
// Idempotency is the UPDATE itself: it is constrained to rows that are
// not already confirmed, and Supabase returns the rows it actually
// changed. Zero rows back means a redelivery of an event we already
// processed, so we return early WITHOUT notifying. This is the pattern
// the flex implementation uses; keeping it means Stripe's at-least-once
// delivery can't produce a second row or a second text.
export async function confirmEventReservation({ session, connectAccount }) {
  if (!session?.id) return { ok: false, reason: 'no_session' };
  if (session.metadata?.source !== EVENT_SOURCE_MARKER) {
    return { ok: false, reason: 'wrong_source' };
  }

  const chargeInfo = await loadCharge(session, connectAccount);

  const patch = {
    status:                'confirmed',
    paid_at:               new Date().toISOString(),
    amount_total_cents:    session.amount_total ?? null,
    stripe_payment_intent: chargeInfo?.payment_intent || null,
    stripe_charge_id:      chargeInfo?.charge_id || null,
    receipt_url:           chargeInfo?.receipt_url || null,
    updated_at:            new Date().toISOString()
  };
  // Fill in the phone Stripe collected if our own form didn't capture one.
  const stripePhone = session.customer_details?.phone
    ? toE164(session.customer_details.phone)
    : null;

  const { data: updated, error } = await supabaseAdmin
    .from('event_reservations')
    .update(patch)
    .eq('stripe_session_id', session.id)
    .neq('status', 'confirmed')
    .select('id, client_id, attendee_phone')
    .maybeSingle();

  if (error) {
    console.error('[event-ingest] confirm update failed:', error.message);
    return { ok: false, reason: 'update_failed', error: error.message };
  }
  if (!updated) {
    // Already confirmed (redelivery), or the row never existed.
    return { ok: true, idempotent: true };
  }

  if (stripePhone && !updated.attendee_phone) {
    await supabaseAdmin.from('event_reservations')
      .update({ attendee_phone: stripePhone })
      .eq('id', updated.id);
  }

  return { ok: true, reservation_id: updated.id, client_id: updated.client_id, idempotent: false };
}

// ── 2. Legacy: mirror a marketing-site destination charge ────────────
//
// Matching, in order of confidence:
//   a. transfer_data.destination identifies the tenant unambiguously —
//      it IS the connected account id, resolved against clients.
//   b. Within that tenant, the event is matched on the customer total the
//      session actually charged, compared against each event's quoted
//      total. Deterministic and self-documenting: if you change an
//      event's price the matcher follows automatically.
//   c. If exactly one published event exists for the tenant and nothing
//      matched on amount, fall back to it and flag amount_mismatch, so a
//      price edit mid-sale still records the payment rather than dropping
//      it on the floor.
export async function ingestLegacyEventSession({ session }) {
  if (!session?.id) return { ok: false, reason: 'no_session' };
  if (session.payment_status !== 'paid') return { ok: false, reason: 'not_paid' };
  // Never double-handle a session the portal itself created.
  if (session.metadata?.source === EVENT_SOURCE_MARKER) return { ok: false, reason: 'wrong_source' };

  // Cheap pre-check before spending a Stripe call on the charge lookup.
  {
    const { data: existing } = await supabaseAdmin
      .from('event_reservations').select('id')
      .eq('stripe_session_id', session.id).maybeSingle();
    if (existing) return { ok: true, reservation_id: existing.id, idempotent: true };
  }

  // (a) Which tenant? The destination account is the only trustworthy
  // signal here — we can't rely on metadata we didn't write.
  const chargeInfo = await loadCharge(session, null);
  const destination = chargeInfo?.transfer_destination;
  if (!destination) return { ok: false, reason: 'no_transfer_destination' };

  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, platform_fee_pct')
    .eq('stripe_connected_account_id', destination)
    .maybeSingle();
  if (!client) {
    return {
      ok: false, reason: 'tenant_not_resolved', destination,
      transfer_destination_present: true
    };
  }

  // (b) Which event? Quote each candidate and compare to what was charged.
  const { data: events } = await supabaseAdmin
    .from('tenant_events')
    .select('*')
    .eq('client_id', client.id)
    .in('status', ['published', 'closed']);
  if (!events?.length) return { ok: false, reason: 'no_events_for_tenant', transfer_destination_present: true };

  const charged = session.amount_total ?? 0;
  let matched = null;
  let amountMismatch = false;
  for (const ev of events) {
    const q = quoteEventSeat({
      listPriceCents:           ev.price_cents,
      quantity:                 1,
      platformFeePct:           resolvePlatformFeePct({ platform_fee_pct: ev.platform_fee_pct ?? client.platform_fee_pct }),
      processingFeeCents:       ev.processing_fee_cents,
      passStripeFeesToCustomer: ev.pass_stripe_fees_to_customer
    });
    if (q.customer_total_cents === charged) { matched = { ev, q }; break; }
  }
  if (!matched) {
    // (c) Single-event fallback.
    const published = events.filter(e => e.status === 'published');
    if (published.length !== 1) {
      return { ok: false, reason: 'event_not_matched', charged_cents: charged, transfer_destination_present: true };
    }
    const ev = published[0];
    amountMismatch = true;
    matched = {
      ev,
      q: quoteEventSeat({
        listPriceCents:           ev.price_cents,
        quantity:                 1,
        platformFeePct:           resolvePlatformFeePct({ platform_fee_pct: ev.platform_fee_pct ?? client.platform_fee_pct }),
        processingFeeCents:       ev.processing_fee_cents,
        passStripeFeesToCustomer: ev.pass_stripe_fees_to_customer
      })
    };
  }

  const { ev, q } = matched;
  const details = session.customer_details || {};
  const phone = details.phone ? toE164(details.phone) : null;

  // Waiver: the marketing site records acceptance as a bare boolean in its
  // own table and never stored the text, so a mirrored row can only ever
  // carry "accepted, under this version". That's a real and permanent
  // limit on the historical rows — nothing in the portal can reconstruct
  // copy that was never saved. Going forward the portal snapshots the
  // full text at acceptance time. scripts/backfill-bootcamp-signups.mjs
  // fills in the boolean + phone from the FLEX database for these rows.
  let reservationId;
  try {
    const { data, error } = await supabaseAdmin.rpc('reserve_event_seats', {
      p_event_id:              ev.id,
      p_client_id:             client.id,
      p_quantity:              1,
      p_attendee_name:         details.name || 'Unknown',
      p_attendee_email:        details.email || session.customer_email || null,
      p_attendee_phone:        phone,
      p_waiver_accepted:       true,               // enforced by the site's CHECK constraint
      p_waiver_version:        ev.waiver_version,
      p_waiver_text:           null,               // never captured per-row upstream
      p_waiver_text_sha256:    null,
      p_waiver_ip:             null,
      p_waiver_user_agent:     null,
      p_idempotency_key:       null,
      p_source:                'flex_marketing_site',
      p_source_url:            null,
      p_status:                'confirmed',        // money is already collected
      p_stripe_session_id:     session.id,
      p_list_price_cents:      ev.price_cents,
      p_amount_total_cents:    charged,
      p_platform_fee_cents:    q.platform_fee_cents,
      p_stripe_fee_cents:      q.stripe_fee_cents,
      // Destination charge: the platform paid Stripe, so the fee it
      // actually retained was platform + stripe. Recorded as charged, not
      // as the direct-charge model would compute it.
      p_application_fee_cents: q.platform_fee_cents + q.stripe_fee_cents
    });
    if (error) throw error;
    reservationId = data;
  } catch (e) {
    console.error('[event-ingest] reserve_event_seats failed:', e?.message);
    return { ok: false, reason: 'insert_failed', error: e?.message };
  }

  // Stamp the payment + notification bookkeeping. confirmation_sent_at is
  // set even though WE never sent anything — the marketing site did, and
  // this permanently blocks a duplicate text from lib/event-notify.js.
  await supabaseAdmin.from('event_reservations').update({
    stripe_payment_intent: chargeInfo?.payment_intent || null,
    stripe_charge_id:      chargeInfo?.charge_id || null,
    receipt_url:           chargeInfo?.receipt_url || null,
    confirmation_sent_at:  new Date().toISOString(),
    tenant_alert_sent_at:  new Date().toISOString(),
    updated_at:            new Date().toISOString()
  }).eq('id', reservationId);

  return {
    ok: true,
    reservation_id: reservationId,
    client_id: client.id,
    event_id: ev.id,
    idempotent: false,
    amount_mismatch: amountMismatch
  };
}

// ── Backfill / safety net ────────────────────────────────────────────
// Scans recent Checkout Sessions ON THE PLATFORM ACCOUNT and mirrors any
// that were destined for a connected tenant and match one of their events.
// Serves two purposes: pulling in everything already sold before this
// shipped, and acting as a webhook-independent safety net (same role
// api/cron/sync-stripe-orders.js plays for merch).
export async function backfillLegacyEventSessions({ hoursBack = 720, maxSessions = 100 } = {}) {
  const since = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
  const out = {
    scanned: 0, ingested: 0, idempotent: 0, skipped: 0, mismatched: 0,
    // Why each session was passed over. A bare skip count is useless for
    // diagnosis — "36 scanned, 36 skipped" could equally mean none were
    // paid, none were destination charges, or the tenant lookup failed,
    // and those need very different fixes. Tally the reasons so a run
    // explains itself instead of requiring a redeploy to find out.
    reasons: {},
    // Coarse shape of what's on the account, independent of matching.
    // Confirms or refutes the premise this whole path rests on: that the
    // marketing site's bootcamp charges are destination charges sitting
    // on the platform account.
    paid: 0, with_transfer_destination: 0,
    errors: []
  };
  const note = (k) => { out.reasons[k] = (out.reasons[k] || 0) + 1; };

  try {
    const list = await stripe.checkout.sessions.list({
      limit: Math.min(100, maxSessions),
      created: { gte: since }
    });
    for (const session of list.data || []) {
      out.scanned++;
      if (session.payment_status !== 'paid') {
        out.skipped++; note('not_paid:' + (session.payment_status || 'unknown'));
        continue;
      }
      out.paid++;
      const r = await ingestLegacyEventSession({ session });
      if (r.transfer_destination_present) out.with_transfer_destination++;
      if (!r.ok) { out.skipped++; note(r.reason || 'unknown'); continue; }
      if (r.idempotent) out.idempotent++;
      else out.ingested++;
      if (r.amount_mismatch) out.mismatched++;
    }
  } catch (e) {
    out.errors.push({ stage: 'list_sessions', error: e?.message });
  }
  return out;
}
