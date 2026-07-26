// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Public POST endpoint that turns a tenant funnel's "Reserve" click
// into a hosted Stripe Checkout Session for the deposit. Called at
// STEP 3 of the KB booking flow (the "Pay $200 deposit" step).
//
// The portal owns Stripe integration end-to-end: the tenant funnel
// (konqueredkocktails.com) POSTs here with the booking details and
// gets back a checkout_url to redirect the guest to. Tenant sites
// never touch the Stripe SDK or hold API keys.
//
// MONEY-SAFETY RULE (must be preserved):
//   If the tenant has NOT connected their Stripe account, this
//   endpoint returns 402 with error='stripe_not_configured' instead
//   of falling back to a platform charge. The KK site promises the
//   guest their deposit goes to Stephen Simmons — routing it into
//   GoElev8's balance would break that written promise.
//
// Body:
//   {
//     booking_id?: uuid,               // if Step 1 already created one — will be promoted
//     lead_id?:    uuid,               // alt lookup
//     // guest details (redundant if booking_id present, but required if not):
//     name, email, phone,
//     experience_key, experience_display,
//     // when
//     event_starts_at:  '2026-07-26T19:00:00-05:00',  // ISO 8601 with tz offset
//     event_tz:         'America/Chicago',
//     when_display:     'Sat, Jul 26 at 7:00 PM',
//     duration_min:     120,
//     guest_count:      6,
//     // money
//     deposit_cents:    20000,         // portal validates against tenant config
//     // urls
//     success_url, cancel_url
//   }
// Response: { checkout_url, booking_id }

import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { toE164 } from '../../lib/phone.js';
import { authTenantWriteKey, setCorsHeaders } from '../../lib/tenant-write-key.js';

const DEFAULT_APPLICATION_FEE_CENTS = 1000; // $10 platform take on a $200 deposit
const MIN_DEPOSIT_CENTS = 500;   // $5 floor
const MAX_DEPOSIT_CENTS = 500000; // $5,000 ceiling — sanity guardrail

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function isHttpUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, req.headers.origin || '*');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = await authTenantWriteKey(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  setCorsHeaders(res, auth.corsOrigin);

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }

  // ── Load tenant (for connected account + config) ────────────────
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, business_name, stripe_connected_account_id')
    .eq('id', auth.clientId)
    .maybeSingle();
  if (clientErr) return res.status(500).json({ ok: false, error: clientErr.message });
  if (!client)   return res.status(404).json({ ok: false, error: 'tenant_not_found' });

  // ── Money-safety gate — 402, never a platform-charge fallback ──
  if (!client.stripe_connected_account_id) {
    return res.status(402).json({
      ok: false,
      error: 'stripe_not_configured',
      message: 'This tenant has not connected their Stripe account. The deposit must land in the tenant\'s balance per the guest-facing promise on the funnel site.'
    });
  }

  // ── Booking resolution: existing lead row OR create new ────────
  let booking = null;
  if (body?.booking_id) {
    const { data } = await supabaseAdmin
      .from('experience_bookings').select('*')
      .eq('id', body.booking_id).eq('client_id', client.id).maybeSingle();
    booking = data;
  } else if (body?.lead_id) {
    const { data } = await supabaseAdmin
      .from('experience_bookings').select('*')
      .eq('lead_id', body.lead_id).eq('client_id', client.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    booking = data;
  }

  const name  = String(body?.name  || booking?.guest_name  || '').trim();
  const email = String(body?.email || booking?.guest_email || '').trim();
  const phone = String(body?.phone || booking?.guest_phone || '').trim();
  if (!name)  return res.status(400).json({ ok: false, error: 'name_required' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ ok: false, error: 'valid_email_required' });
  const e164 = phone ? toE164(phone) : null;

  const eventStartsAt = body?.event_starts_at || booking?.event_starts_at;
  if (!eventStartsAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(eventStartsAt))) {
    return res.status(400).json({ ok: false, error: 'event_starts_at_iso8601_required' });
  }
  const startsMs = new Date(eventStartsAt).getTime();
  if (!Number.isFinite(startsMs)) return res.status(400).json({ ok: false, error: 'event_starts_at_unparseable' });

  const experienceKey     = String(body?.experience_key || booking?.experience_key || '').trim().slice(0, 60);
  const experienceDisplay = String(body?.experience_display || booking?.experience_display || 'Experience').trim().slice(0, 120);
  const whenDisplay       = body?.when_display ? String(body.when_display).slice(0, 200) : null;
  const eventTz           = body?.event_tz || booking?.event_tz || 'America/Chicago';
  const durationMin       = Number.isFinite(+body?.duration_min) ? Math.floor(+body.duration_min) : (booking?.duration_min || 120);
  const guestCount        = Number.isFinite(+body?.guest_count)  ? Math.floor(+body.guest_count)  : (booking?.guest_count  || null);

  // ── Deposit amount validation ──────────────────────────────────
  const depositCents = Number.isFinite(+body?.deposit_cents) ? Math.floor(+body.deposit_cents) : NaN;
  if (!Number.isFinite(depositCents) || depositCents < MIN_DEPOSIT_CENTS || depositCents > MAX_DEPOSIT_CENTS) {
    return res.status(400).json({ ok: false, error: 'invalid_deposit_amount', min: MIN_DEPOSIT_CENTS, max: MAX_DEPOSIT_CENTS });
  }

  // ── Upsert the booking row: create new if not found; promote to
  //    deposit_pending on existing lead. We keep the row at
  //    deposit_pending until the webhook flips it to confirmed.
  //    This ensures the availability API immediately blocks the slot
  //    (so a concurrent guest can't grab the same time while payment
  //    is in flight). If payment fails/expires, the async_payment_failed
  //    webhook branch flips it back to 'lead'.
  const bookingPayload = {
    client_id:           client.id,
    status:              'deposit_pending',
    experience_key:      experienceKey || null,
    experience_display:  experienceDisplay,
    event_starts_at:     new Date(eventStartsAt).toISOString(),
    event_tz:            eventTz,
    when_display:        whenDisplay,
    duration_min:        durationMin,
    guest_count:         guestCount,
    guest_name:          name,
    guest_email:         email,
    guest_phone:         e164 || phone || null,
    deposit_cents:       depositCents,
    updated_at:          new Date().toISOString()
  };
  let bookingId;
  if (booking) {
    const { data, error } = await supabaseAdmin
      .from('experience_bookings').update(bookingPayload)
      .eq('id', booking.id).select('id').single();
    if (error) return res.status(500).json({ ok: false, error: 'booking_update_failed', detail: error.message });
    bookingId = data.id;
  } else {
    const { data, error } = await supabaseAdmin
      .from('experience_bookings').insert({ ...bookingPayload, source: 'external_funnel' })
      .select('id').single();
    if (error) return res.status(500).json({ ok: false, error: 'booking_insert_failed', detail: error.message });
    bookingId = data.id;
  }

  // ── Stripe Checkout Session — direct charge on connected account ─
  const origin = String(req.headers['origin'] || '').replace(/\/+$/, '');
  const successUrl = isHttpUrl(body?.success_url)
    ? body.success_url
    : (origin ? origin + '/?paid=1&session_id={CHECKOUT_SESSION_ID}' : 'https://example.com/?paid=1');
  const cancelUrl = isHttpUrl(body?.cancel_url)
    ? body.cancel_url
    : (origin ? origin + '/' : 'https://example.com/');

  const lineDescription = [
    whenDisplay,
    guestCount ? `${guestCount} guests` : null
  ].filter(Boolean).join(' · ');

  const sharedMetadata = {
    source:              'experience_deposit',
    portal_client_id:    String(client.id),
    client_slug:         String(client.slug),
    booking_id:          String(bookingId),
    experience_key:      experienceKey || '',
    experience_display:  experienceDisplay,
    event_starts_at:     new Date(eventStartsAt).toISOString(),
    event_tz:            eventTz,
    when_display:        whenDisplay || '',
    duration_min:        String(durationMin || ''),
    guest_count:         String(guestCount || ''),
    guest_email:         email,
    guest_phone:         e164 || phone || '',
    deposit_cents:       String(depositCents),
    application_fee_cents: String(DEFAULT_APPLICATION_FEE_CENTS)
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: depositCents,
          product_data: {
            name: `Deposit — ${experienceDisplay}`,
            description: lineDescription || undefined
          }
        }
      }],
      customer_email: email,
      phone_number_collection: { enabled: !e164 },
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        application_fee_amount: DEFAULT_APPLICATION_FEE_CENTS,
        metadata: sharedMetadata,
        description: `Deposit for ${experienceDisplay}${whenDisplay ? ` — ${whenDisplay}` : ''}`
      },
      metadata: sharedMetadata
    }, { stripeAccount: client.stripe_connected_account_id });

    // Persist session id on the booking so the webhook can idempotently
    // look this booking up when checkout.session.completed fires.
    await supabaseAdmin.from('experience_bookings')
      .update({ stripe_session_id: session.id, updated_at: new Date().toISOString() })
      .eq('id', bookingId);

    return res.status(200).json({ ok: true, checkout_url: session.url, booking_id: bookingId });
  } catch (e) {
    const msg = e?.message || 'stripe_error';
    return res.status(502).json({ ok: false, error: 'stripe_error', message: msg });
  }
}
