// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Portal-hosted event seat reservation + Stripe Checkout. This is what
// theflexfacility.com/bootcamp calls instead of running its own Stripe
// SDK, so the marketing site stops holding payment credentials.
//
// POST /api/external/event-reservations
//   Authorization: Bearer <raw client_api_keys value, scope events:write>
//   {
//     event_key:       'roq-n-flex-bootcamp',
//     name, email, phone,
//     waiver_accepted: true,
//     waiver_version:  '…',        // echoed from GET /api/external/events
//     quantity?:       1,
//     idempotency_key?: uuid,
//     success_url, cancel_url
//   }
//   → { ok, checkout_url, reservation_id }
//
// SERVER-TO-SERVER ONLY — no CORS headers here on purpose. The tenant's
// own serverless function proxies this call so the API key stays in its
// environment and never reaches a browser. That's also why this uses a
// Bearer key rather than lib/tenant-write-key.js: authTenantWriteKey()
// deliberately allows requests with no Origin header (server-to-server
// callers need that), which means a browser-visible write key can be
// lifted and replayed from curl. Acceptable for reading availability;
// not for taking money and recording a liability waiver.
//
// Key storage is client_api_keys (sha256-hashed, scoped, revocable —
// migration 0029), the same table api/external/lead.js authenticates
// against, rather than the plaintext clients.portal_api_key column.
//
// MONEY-SAFETY RULE, inherited from api/external/experience-deposit.js:
// a tenant with no connected Stripe account gets a 402, never a fallback
// charge into the GoElev8 platform balance.
//
// CHARGE MODEL — direct charge on the connected account
// ({ stripeAccount }), matching api/external/checkout.js and
// experience-deposit.js. Stripe debits its fee from the tenant's balance,
// which is exactly what the customer surcharge is sized to cover, so
// application_fee_amount is the PLATFORM FEE ONLY. See quoteEventSeat()
// in lib/platform-fee.js for why sending platform+stripe here would
// double-charge the tenant and leave them at $8.39 on a $10 seat instead
// of the required $9.00.

import { createHash } from 'node:crypto';
import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { toE164 } from '../../lib/phone.js';
import { quoteEventSeat, resolvePlatformFeePct } from '../../lib/platform-fee.js';
import { EVENT_SOURCE_MARKER, sha256Hex } from '../../lib/event-ingest.js';

// Stripe Checkout sessions default to 24h; 30 minutes keeps an abandoned
// cart from sitting on a seat all day. checkout.session.expired then
// releases it via release_event_seats().
const SESSION_TTL_MIN = 30;
const MAX_QUANTITY = 10;

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

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.headers['x-real-ip'] || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // ── Auth: hashed Bearer key → tenant. Never from the request body. ──
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!m) return res.status(401).json({ ok: false, error: 'missing_bearer_token' });
  const keyHash = createHash('sha256').update(m[1].trim()).digest('hex');

  const { data: keyRow, error: keyErr } = await supabaseAdmin
    .from('client_api_keys')
    .select('id, client_id, revoked_at, scopes')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (keyErr) return res.status(500).json({ ok: false, error: 'key_lookup_failed' });
  if (!keyRow || keyRow.revoked_at) {
    return res.status(401).json({ ok: false, error: 'invalid_or_revoked_key' });
  }
  const scopes = Array.isArray(keyRow.scopes) ? keyRow.scopes : [];
  if (scopes.length && !scopes.includes('events:write')) {
    return res.status(403).json({ ok: false, error: 'insufficient_scope', required: 'events:write' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }

  // ── Tenant + event ────────────────────────────────────────────────
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, business_name, platform_fee_pct, stripe_connected_account_id')
    .eq('id', keyRow.client_id)
    .maybeSingle();
  if (clientErr) return res.status(500).json({ ok: false, error: clientErr.message });
  if (!client)   return res.status(404).json({ ok: false, error: 'tenant_not_found' });

  const eventKey = String(body?.event_key || '').trim();
  if (!eventKey) return res.status(400).json({ ok: false, error: 'event_key_required' });

  const { data: ev } = await supabaseAdmin
    .from('tenant_events').select('*')
    .eq('client_id', client.id).eq('event_key', eventKey).maybeSingle();
  if (!ev) return res.status(404).json({ ok: false, error: 'event_not_found' });
  if (ev.status !== 'published') {
    return res.status(409).json({ ok: false, error: 'event_not_published', status: ev.status });
  }

  // ── Money-safety gate — 402, never a platform-balance fallback ────
  if (!client.stripe_connected_account_id) {
    return res.status(402).json({
      ok: false,
      error: 'stripe_not_configured',
      message: 'This tenant has not connected their Stripe account. Seat payments must settle into the tenant\'s own balance.'
    });
  }

  // ── Validate the public form input ────────────────────────────────
  const name  = String(body?.name  || '').trim().slice(0, 120);
  const email = String(body?.email || '').trim().slice(0, 200);
  const phoneRaw = String(body?.phone || '').trim();
  if (!name)  return res.status(400).json({ ok: false, error: 'name_required' });
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'valid_email_required' });
  }
  const phone = phoneRaw ? toE164(phoneRaw) : null;
  if (phoneRaw && !phone) {
    return res.status(400).json({ ok: false, error: 'valid_phone_required' });
  }

  let quantity = Number.isFinite(+body?.quantity) ? Math.floor(+body.quantity) : 1;
  if (quantity < 1) quantity = 1;
  if (quantity > MAX_QUANTITY) {
    return res.status(400).json({ ok: false, error: 'quantity_too_large', max: MAX_QUANTITY });
  }

  // ── Waiver ────────────────────────────────────────────────────────
  // The text is snapshotted from OUR event row, never from the request —
  // a caller cannot influence what we record as having been agreed to.
  // The browser only tells us which version it displayed.
  if (ev.waiver_required) {
    if (!ev.waiver_text) {
      return res.status(409).json({
        ok: false,
        error: 'waiver_not_configured',
        message: 'This event requires a waiver but no waiver text is set on the event in the portal. Paste the live copy into the event before taking reservations.'
      });
    }
    if (body?.waiver_accepted !== true) {
      return res.status(400).json({ ok: false, error: 'waiver_acceptance_required' });
    }
    const shown = String(body?.waiver_version || '').trim();
    if (!shown || shown !== String(ev.waiver_version || '')) {
      // The page rendered copy we've since replaced. Refuse rather than
      // record an acceptance against text the person never actually read.
      return res.status(409).json({
        ok: false,
        error: 'waiver_version_stale',
        expected_version: ev.waiver_version,
        message: 'The waiver was revised after this page loaded. Re-fetch /api/external/events and prompt again.'
      });
    }
  }

  // ── Price, from config — never from the caller ────────────────────
  const quote = quoteEventSeat({
    listPriceCents:           ev.price_cents,
    quantity,
    platformFeePct:           resolvePlatformFeePct({ platform_fee_pct: ev.platform_fee_pct ?? client.platform_fee_pct }),
    processingFeeCents:       ev.processing_fee_cents,
    passStripeFeesToCustomer: ev.pass_stripe_fees_to_customer
  });

  // ── Hold the seat (capacity enforced under a row lock) ─────────────
  let reservationId;
  try {
    const { data, error } = await supabaseAdmin.rpc('reserve_event_seats', {
      p_event_id:              ev.id,
      p_client_id:             client.id,
      p_quantity:              quantity,
      p_attendee_name:         name,
      p_attendee_email:        email,
      p_attendee_phone:        phone,
      p_waiver_accepted:       body?.waiver_accepted === true,
      p_waiver_version:        ev.waiver_version,
      p_waiver_text:           ev.waiver_text,
      p_waiver_text_sha256:    ev.waiver_text ? sha256Hex(ev.waiver_text) : null,
      p_waiver_ip:             clientIp(req),
      p_waiver_user_agent:     String(req.headers['user-agent'] || '').slice(0, 400) || null,
      p_idempotency_key:       body?.idempotency_key ? String(body.idempotency_key).slice(0, 100) : null,
      p_source:                'external_funnel',
      p_source_url:            body?.source_url ? String(body.source_url).slice(0, 512) : null,
      p_status:                'pending',
      p_stripe_session_id:     null,
      p_list_price_cents:      ev.price_cents,
      p_amount_total_cents:    quote.customer_total_cents,
      p_platform_fee_cents:    quote.platform_fee_cents,
      p_stripe_fee_cents:      quote.stripe_fee_cents,
      p_application_fee_cents: quote.application_fee_cents
    });
    if (error) throw error;
    reservationId = data;
  } catch (e) {
    const msg = e?.message || '';
    if (/sold_out/.test(msg))          return res.status(409).json({ ok: false, error: 'sold_out' });
    if (/waiver_required/.test(msg))   return res.status(400).json({ ok: false, error: 'waiver_acceptance_required' });
    if (/event_not_published/.test(msg)) return res.status(409).json({ ok: false, error: 'event_not_published' });
    if (/event_not_found/.test(msg))   return res.status(404).json({ ok: false, error: 'event_not_found' });
    console.error('[event-reservations] reserve failed:', msg);
    return res.status(500).json({ ok: false, error: 'reservation_failed' });
  }

  // A repeated idempotency_key returns the original row. If that row
  // already has a session, hand back the same checkout URL instead of
  // opening a second one against the same seat.
  {
    const { data: existing } = await supabaseAdmin
      .from('event_reservations').select('id, stripe_session_id, status')
      .eq('id', reservationId).maybeSingle();
    if (existing?.stripe_session_id) {
      try {
        const s = await stripe.checkout.sessions.retrieve(
          existing.stripe_session_id, { stripeAccount: client.stripe_connected_account_id });
        if (s?.url && s.status === 'open') {
          return res.status(200).json({
            ok: true, checkout_url: s.url, reservation_id: existing.id, idempotent: true
          });
        }
      } catch { /* fall through and mint a fresh session */ }
    }
  }

  // ── Stripe Checkout — direct charge on the connected account ──────
  const origin = String(req.headers['origin'] || '').replace(/\/+$/, '');
  const successUrl = isHttpUrl(body?.success_url)
    ? body.success_url
    : (origin ? origin + '/?paid=1&session_id={CHECKOUT_SESSION_ID}' : 'https://example.com/?paid=1');
  const cancelUrl = isHttpUrl(body?.cancel_url)
    ? body.cancel_url
    : (origin ? origin + '/' : 'https://example.com/');

  const sharedMetadata = {
    source:                EVENT_SOURCE_MARKER,
    portal_client_id:      String(client.id),
    client_slug:           String(client.slug),
    reservation_id:        String(reservationId),
    event_id:              String(ev.id),
    event_key:             ev.event_key,
    quantity:              String(quantity),
    list_price_cents:      String(quote.subtotal_cents),
    platform_fee_cents:    String(quote.platform_fee_cents),
    stripe_fee_cents:      String(quote.stripe_fee_cents),
    application_fee_cents: String(quote.application_fee_cents),
    waiver_version:        String(ev.waiver_version || '')
  };

  const lineItems = [{
    quantity,
    price_data: {
      currency: ev.currency || 'usd',
      unit_amount: ev.price_cents,
      product_data: {
        name: ev.title,
        description: [ev.location_name, ev.address_line1, ev.city].filter(Boolean).join(' · ') || undefined,
        images: ev.image_url ? [ev.image_url] : []
      }
    }
  }];
  // Customer-visible surcharge line so the total isn't a surprise. This
  // is the amount that covers Stripe's cut of the whole charge, which the
  // tenant's balance is debited for — it is NOT additional platform take.
  if (quote.stripe_fee_cents + quote.processing_fee_cents > 0) {
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: ev.currency || 'usd',
        unit_amount: quote.stripe_fee_cents + quote.processing_fee_cents,
        product_data: {
          name: 'Card processing',
          description: 'Covers card processing on this transaction.'
        }
      }
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      customer_email: email,
      // Only ask Stripe for a phone when our own form didn't supply one —
      // no address collection at all, since a seat isn't shipped anywhere.
      phone_number_collection: { enabled: !phone },
      expires_at: Math.floor(Date.now() / 1000) + SESSION_TTL_MIN * 60,
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        application_fee_amount: quote.application_fee_cents,
        metadata: sharedMetadata,
        description: `${ev.title}${quantity > 1 ? ` × ${quantity}` : ''}`
      },
      metadata: sharedMetadata
    }, { stripeAccount: client.stripe_connected_account_id });

    await supabaseAdmin.from('event_reservations')
      .update({ stripe_session_id: session.id, updated_at: new Date().toISOString() })
      .eq('id', reservationId);

    return res.status(200).json({
      ok: true,
      checkout_url: session.url,
      reservation_id: reservationId,
      total_cents: quote.customer_total_cents
    });
  } catch (e) {
    // Stripe rejected us — hand the held seat back rather than leaving a
    // pending row squatting on capacity until its TTL runs out.
    await supabaseAdmin.from('event_reservations')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('id', reservationId).eq('status', 'pending');
    const { data: cur } = await supabaseAdmin
      .from('tenant_events').select('seats_reserved').eq('id', ev.id).maybeSingle();
    if (cur) {
      await supabaseAdmin.from('tenant_events')
        .update({ seats_reserved: Math.max(0, (cur.seats_reserved || 0) - quantity) })
        .eq('id', ev.id);
    }
    return res.status(502).json({ ok: false, error: 'stripe_error', message: e?.message || 'stripe_error' });
  }
}
