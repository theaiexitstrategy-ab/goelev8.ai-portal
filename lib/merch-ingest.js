// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Shared ingestion path for Stripe Checkout Sessions created via
// api/external/checkout.js (source='portal_external_checkout').
// Used by both:
//   - api/stripe/webhook.js, on checkout.session.completed
//   - api/admin.js (action=backfill-external-merch-orders), to pull
//     orders that completed before the webhook handler knew about
//     them (or before the Connect webhook subscription existed)
//
// Idempotent on stripe_payment_id so replays + backfills + duplicate
// webhook deliveries all converge to one merch_orders row.

import { stripe } from './stripe.js';
import { supabaseAdmin } from './supabase.js';
import { sendPushToClient, sendPushToAdmins } from './push.js';
import { sendOrderReceivedSms } from './transactional-sms.js';

// Columns we need on the tenant row to (a) write the order, (b) push
// notify, (c) send the order-received SMS, and (d) decide whether to
// send the pickup or shipping variant of that SMS. Kept as one
// constant so the two resolveTenant branches don't drift.
const TENANT_COLS =
  'id, slug, name, twilio_phone_number, twilio_subaccount_sid, ' +
  'twilio_auth_token, credit_balance, ' +
  'pickup_enabled, pickup_location, pickup_instructions';

// Columns the SELECT falls back to when pickup_* columns haven't been
// migrated yet. Keeps the ingest working on pre-migration projects
// while the migration is pending.
const TENANT_COLS_LEGACY =
  'id, slug, name, twilio_phone_number, twilio_subaccount_sid, ' +
  'twilio_auth_token, credit_balance';

// Resolves the portal tenant for a session. Prefers the metadata key
// my checkout endpoint stamps; falls back to looking up the connected
// account id (event.account, set by Stripe on Connect webhook delivery).
async function resolveTenant({ session, connectAccount }) {
  async function loadByEq(col, val) {
    let { data, error } = await supabaseAdmin
      .from('clients').select(TENANT_COLS).eq(col, val).maybeSingle();
    if (error && /column .*(pickup_enabled|pickup_location|pickup_instructions).* does not exist/i.test(error.message || '')) {
      const retry = await supabaseAdmin
        .from('clients').select(TENANT_COLS_LEGACY).eq(col, val).maybeSingle();
      data = retry.data;
    }
    return data || null;
  }
  const metaId = session?.metadata?.portal_client_id;
  if (metaId) {
    const data = await loadByEq('id', metaId);
    if (data) return data;
  }
  if (connectAccount) {
    const data = await loadByEq('stripe_connected_account_id', connectAccount);
    if (data) return data;
  }
  return null;
}

// Was the customer's chosen shipping option the in-person pickup
// rate (the $0 'Pick up at …' option api/external/checkout.js adds
// when the tenant has pickup_enabled=true)? Detected by retrieving
// the chosen rate from Stripe and matching its display_name against
// the 'Pick up' prefix the checkout endpoint stamps.
async function isPickupOrder(session, connectAccount) {
  const rateId = session?.shipping_cost?.shipping_rate;
  if (!rateId) return false;
  try {
    const rate = await stripe.shippingRates.retrieve(
      rateId, connectAccount ? { stripeAccount: connectAccount } : undefined
    );
    return /^pick\s*up/i.test(rate?.display_name || '');
  } catch (e) {
    console.warn('[merch-ingest] shippingRates.retrieve failed:', e?.message);
    // Conservative fallback: if shipping cost was $0 and pickup is
    // enabled on the tenant, assume pickup. False positives are
    // acceptable here — the operator can recover; false negatives
    // would send the wrong SMS.
    return false;
  }
}

// Has the order-received SMS already gone out for this Stripe PI?
// Looks for an outbound message with credit_ledger.ref_id matching the
// payment intent. Cheaper than the body-match dedupe and ties the SMS
// to the actual charge so Stripe webhook redeliveries can't double-send.
async function orderReceivedSmsAlreadySent(clientId, stripePaymentId) {
  if (!stripePaymentId) return false;
  const { data } = await supabaseAdmin
    .from('credit_ledger')
    .select('id')
    .eq('client_id', clientId)
    .eq('reason', 'order_received_sms')
    .eq('ref_id', stripePaymentId)
    .limit(1)
    .maybeSingle();
  return !!data;
}

// Inserts merch_orders + merch_order_items rows for a single Checkout
// Session. Returns { ok, order_id, idempotent, reason } so callers can
// log what happened without throwing.
//
// session       — the Stripe Checkout Session object (post-completion)
// connectAccount — the connected account id (event.account on webhook,
//                  or passed explicitly during backfill)
export async function ingestExternalMerchOrder({ session, connectAccount }) {
  if (!session?.id) return { ok: false, reason: 'no_session' };

  // Only handle sessions we created (avoids stomping on the existing
  // sales/credit-pack handlers when the webhook receives unrelated
  // checkout.session.completed events).
  if (session.metadata?.source !== 'portal_external_checkout') {
    return { ok: false, reason: 'wrong_source' };
  }

  // Idempotency. stripe_payment_id is the PI for paid sessions; for
  // free/zero-amount sessions we fall back to the session id so we
  // never insert duplicates (the UNIQUE constraint on the table would
  // surface as an error otherwise).
  const stripePaymentId = session.payment_intent || session.id;
  {
    const { data: existing } = await supabaseAdmin
      .from('merch_orders').select('id, created_at')
      .eq('stripe_payment_id', stripePaymentId).maybeSingle();
    if (existing) {
      return { ok: true, order_id: existing.id, idempotent: true };
    }
  }

  const tenant = await resolveTenant({ session, connectAccount });
  if (!tenant?.id) return { ok: false, reason: 'tenant_not_resolved' };

  // Pull line items from the connected account. The Session object
  // doesn't include line_items by default; we have to list them
  // separately and scope the request to the tenant's account.
  let lineItems = [];
  try {
    const list = await stripe.checkout.sessions.listLineItems(
      session.id, { limit: 100 }, connectAccount ? { stripeAccount: connectAccount } : undefined
    );
    lineItems = list.data || [];
  } catch (e) {
    // Non-fatal — write the order row with zero items, operator can
    // open the Stripe dashboard for the missing context.
    console.warn('[merch-ingest] listLineItems failed:', e?.message);
  }

  const ship = session.shipping_details || session.shipping || {};
  const shipAddr = ship.address || {};

  const orderRow = {
    client_id:            tenant.id,
    customer_name:        session.customer_details?.name || ship.name || null,
    customer_email:       session.customer_details?.email || null,
    customer_phone:       session.customer_details?.phone || null,
    shipping_address1:    shipAddr.line1 || null,
    shipping_address2:    shipAddr.line2 || null,
    shipping_city:        shipAddr.city || null,
    shipping_state:       shipAddr.state || null,
    shipping_zip:         shipAddr.postal_code || null,
    shipping_country:     shipAddr.country || 'US',
    subtotal_cents:       session.amount_subtotal || 0,
    shipping_cents:       session.total_details?.amount_shipping || 0,
    discount_cents:       session.total_details?.amount_discount || 0,
    total_cents:          session.amount_total || 0,
    // Splits set by api/external/checkout.js. platform_fee_cents is
    // the 10% (or per-tenant override) cut on subtotal; the flat $3
    // processing_fee_cents is broken out so the portal Orders ledger
    // can show each piece separately. Both go to GoElev8.
    platform_fee_cents:   parseInt(session.metadata?.platform_fee_cents   || '0', 10) || 0,
    processing_fee_cents: parseInt(session.metadata?.processing_fee_cents || '0', 10) || 0,
    stripe_fee_cents:     0,
    coupon_code:          null,
    stripe_payment_id:    stripePaymentId,
    external_order_number: session.id,
    status:               'paid'
  };

  // Tolerant insert — strip fee columns and retry if the
  // processing_fee_cents / platform_fee_cents migrations haven't been
  // applied yet on this project. Matches the same pattern in
  // api/external/orders.js so behavior is consistent.
  let { data: inserted, error: insErr } = await supabaseAdmin
    .from('merch_orders').insert(orderRow).select('id').single();
  if (insErr && /column .*(platform_fee_cents|processing_fee_cents|stripe_fee_cents).* does not exist/i.test(insErr.message || '')) {
    const legacy = { ...orderRow };
    delete legacy.platform_fee_cents;
    delete legacy.processing_fee_cents;
    delete legacy.stripe_fee_cents;
    const retry = await supabaseAdmin
      .from('merch_orders').insert(legacy).select('id').single();
    inserted = retry.data; insErr = retry.error;
  }
  if (insErr) {
    console.error('[merch-ingest] order insert failed:', insErr.message);
    return { ok: false, reason: 'insert_failed', error: insErr.message };
  }

  if (lineItems.length) {
    // Parse the compact items manifest the checkout endpoint stamps
    // onto session.metadata.items_json. It carries product_key + size
    // + color per line item — the Stripe line_items list itself
    // doesn't preserve those (Stripe only knows the display name +
    // unit_amount). Falls back to the single-item metadata block when
    // the manifest is missing (older sessions / legacy callers).
    let manifest = [];
    try {
      const raw = session.metadata?.items_json;
      if (raw) manifest = JSON.parse(raw);
      if (!Array.isArray(manifest)) manifest = [];
    } catch { manifest = []; }

    // Filter out the "Processing fee" line item — checkout.js adds it
    // as a customer-visible Stripe line item, but it shouldn't appear
    // in merch_order_items because it isn't a product. The remaining
    // lines correspond positionally to the manifest entries.
    const productLines = lineItems.filter(li =>
      !/^processing fee$/i.test(String(li.description || '').trim())
    );

    const itemRows = productLines.map((li, i) => {
      const m = manifest[i] || {};
      return {
        order_id:    inserted.id,
        product_key: m.k || session.metadata?.product_key || null,
        name:        li.description || null,
        color:       m.c || session.metadata?.variant_color || null,
        size:        m.s || session.metadata?.variant_size  || null,
        quantity:    li.quantity || 1,
        price_cents: li.price?.unit_amount ?? li.amount_subtotal ?? 0
      };
    });
    if (itemRows.length) {
      const { error: itemsErr } = await supabaseAdmin
        .from('merch_order_items').insert(itemRows);
      if (itemsErr) {
        // Don't roll back — the order row is the source of truth, items
        // are display detail. Log so we know to reconcile.
        console.warn('[merch-ingest] line item insert failed:', itemsErr.message);
      }
    }
  }

  // Notifications, parity with the existing sales path. Best-effort.
  const total = ((session.amount_total || 0) / 100).toFixed(2);
  const itemName = lineItems[0]?.description || session.metadata?.product_key || 'item';
  await Promise.all([
    sendPushToClient(tenant.id, '🛍️ New Merch Order',
      `${session.customer_details?.name || 'Customer'} bought ${itemName} — $${total}`,
      '/merch'),
    sendPushToAdmins('🛍️ Merch — ' + (tenant.name || tenant.slug || 'Tenant'),
      `${itemName} · $${total}`, '/merch')
  ]).catch(() => {});

  // Order-received SMS to the buyer. Best-effort — never blocks the
  // webhook 200. Skipped silently if the tenant has no Twilio number,
  // the buyer didn't share a phone, or we already texted them for
  // this exact Stripe PI (webhook redelivery).
  //
  // The SMS body branches based on the shipping option the customer
  // picked at checkout: pickup = "ready at <location>"; ship = "USPS
  // in 1-2 weeks". Pickup detection happens by retrieving the chosen
  // shipping rate from Stripe and matching its display_name.
  const buyerPhone = session.customer_details?.phone || null;
  if (buyerPhone && tenant.twilio_phone_number) {
    try {
      const already = await orderReceivedSmsAlreadySent(tenant.id, stripePaymentId);
      if (!already) {
        const isPickup = await isPickupOrder(session, connectAccount);
        await sendOrderReceivedSms({
          client:       tenant,
          to:           buyerPhone,
          customerName: session.customer_details?.name || null,
          stripePaymentId,
          isPickup,
          pickupLocation:     tenant.pickup_location || null,
          pickupInstructions: tenant.pickup_instructions || null
        });
      }
    } catch (e) {
      console.error('[merch-ingest] order-received SMS failed:', e?.message);
    }
  }

  return { ok: true, order_id: inserted.id, idempotent: false };
}

// Backfill helper. Scans recent Checkout Sessions on a connected
// account and ingests any with source='portal_external_checkout'
// that aren't already in merch_orders. Useful for pulling in sessions
// that completed before the Connect webhook subscription existed.
//
// Returns { scanned, ingested, idempotent, skipped, errors }.
export async function backfillExternalMerchOrders({ stripeAccount, hoursBack = 72, maxSessions = 100 }) {
  if (!stripeAccount) return { scanned: 0, errors: ['stripeAccount required'] };
  const since = Math.floor((Date.now() - hoursBack * 60 * 60 * 1000) / 1000);
  const out = { scanned: 0, ingested: 0, idempotent: 0, skipped: 0, errors: [] };

  try {
    const list = await stripe.checkout.sessions.list(
      { limit: Math.min(100, maxSessions), created: { gte: since } },
      { stripeAccount }
    );
    for (const session of list.data || []) {
      out.scanned++;
      if (session.payment_status !== 'paid') { out.skipped++; continue; }
      const result = await ingestExternalMerchOrder({ session, connectAccount: stripeAccount });
      if (!result.ok) {
        if (result.reason === 'wrong_source') out.skipped++;
        else out.errors.push({ session_id: session.id, reason: result.reason, error: result.error });
        continue;
      }
      if (result.idempotent) out.idempotent++;
      else out.ingested++;
    }
  } catch (e) {
    out.errors.push({ stage: 'list_sessions', error: e?.message });
  }
  return out;
}
