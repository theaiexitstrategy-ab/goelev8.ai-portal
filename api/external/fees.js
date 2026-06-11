// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Public fee quote — used by a tenant's storefront at checkout to
// compute the final customer-facing total. Inputs: tenant slug,
// subtotal_cents (sum of line items), shipping_cents. Outputs the
// full breakdown the storefront needs to display + the values it
// must POST back to /api/external/orders so the portal records
// what platform took.
//
// POST /api/external/fees/quote
//   Body: { slug, subtotal_cents, shipping_cents? }
//   → {
//       platform_fee_pct,           // % applied to subtotal (1.0 = 1%)
//       platform_fee_cents,         // platform's cut on this cart
//       stripe_fee_cents,           // pass-through Stripe processing
//       subtotal_cents,             // echoed back
//       shipping_cents,             // echoed back
//       customer_total_cents,       // amount to charge customer
//       tenant_takehome_cents,      // amount tenant receives (pre-shipping cost)
//       pass_stripe_fees_to_customer
//     }
//
// Stripe pass-through assumes US standard processing: 2.9% + $0.30
// per charge. Customer pays this so it doesn't eat into platform fee
// or tenant takehome. Computed AFTER the platform fee + shipping are
// added so the customer's actual paid amount covers everything.

import { supabaseAdmin } from '../../lib/supabase.js';
import {
  PLATFORM_FEE_DEFAULT_PCT,
  resolvePlatformFeePct,
  calcPlatformFeeCents
} from '../../lib/platform-fee.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

// Standard US Stripe pricing for online card charges. Override
// platform-wide via env if your account negotiated different rates.
const STRIPE_FEE_PCT  = parseFloat(process.env.STRIPE_FEE_PCT  || '2.9');
const STRIPE_FEE_FIXED_CENTS = parseInt(process.env.STRIPE_FEE_FIXED_CENTS || '30', 10);

// Flat platform processing fee charged on every order. Goes to the
// platform (GoElev8) alongside the percent-based platform fee — covers
// Stripe overhead on small carts where 10% wouldn't pay for the
// transaction. Override per-tenant via clients.processing_fee_cents if
// a special-cased tenant ever needs a different value.
const DEFAULT_PROCESSING_FEE_CENTS = parseInt(process.env.PROCESSING_FEE_DEFAULT_CENTS || '300', 10);

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Compute the customer-facing total such that, after Stripe takes its
// processing fee, the platform + tenant receive exactly what they
// expect. This is the "surcharge" formula: pre_fee / (1 - pct) + fixed.
//
//   target_received = subtotal + platform_fee + shipping
//   customer_total  = target_received + stripe_pass_through
//   stripe_fee      = customer_total × pct + fixed
//   ∴  customer_total = (target_received + fixed) / (1 - pct)
function applyStripePassThrough(targetReceivedCents) {
  const pctFraction = STRIPE_FEE_PCT / 100;
  const customer = Math.ceil(
    (targetReceivedCents + STRIPE_FEE_FIXED_CENTS) / (1 - pctFraction)
  );
  const stripeFee = customer - targetReceivedCents;
  return { customer, stripeFee };
}

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const slug          = String(body?.slug || '').trim();
  const subtotalCents = Math.max(0, Number.isFinite(+body?.subtotal_cents) ? +body.subtotal_cents : 0);
  const shippingCents = Math.max(0, Number.isFinite(+body?.shipping_cents) ? +body.shipping_cents : 0);
  if (!slug) return res.status(400).json({ error: 'slug required' });

  // Resolve the tenant's fee config + Stripe Connect account in one
  // hit. Tolerant if the optional columns aren't migrated yet — falls
  // back to env defaults / null account.
  let feePct = PLATFORM_FEE_DEFAULT_PCT;
  let processingFeeCents = DEFAULT_PROCESSING_FEE_CENTS;
  let passStripeFees = true;
  let connectedAccountId = null;
  async function loadClient(cols) {
    const { data, error } = await supabaseAdmin
      .from('clients').select(cols).eq('slug', slug).maybeSingle();
    if (error) throw error;
    return data;
  }
  try {
    const client = await loadClient(
      'platform_fee_pct, processing_fee_cents, pass_stripe_fees_to_customer, stripe_connected_account_id'
    );
    if (client) {
      feePct = resolvePlatformFeePct(client);
      if (client.processing_fee_cents != null) {
        processingFeeCents = Math.max(0, parseInt(client.processing_fee_cents, 10));
      }
      if (typeof client.pass_stripe_fees_to_customer === 'boolean') {
        passStripeFees = client.pass_stripe_fees_to_customer;
      }
      if (client.stripe_connected_account_id) {
        connectedAccountId = client.stripe_connected_account_id;
      }
    }
  } catch (e) {
    // Retry without the optional columns if Postgres complained about
    // a missing one. Keeps us forward-compatible on projects mid-
    // migration.
    if (/column .*(processing_fee_cents|stripe_connected_account_id).* does not exist/i.test(e?.message || '')) {
      try {
        const c2 = await loadClient('platform_fee_pct, pass_stripe_fees_to_customer');
        feePct = resolvePlatformFeePct(c2);
        if (typeof c2?.pass_stripe_fees_to_customer === 'boolean') {
          passStripeFees = c2.pass_stripe_fees_to_customer;
        }
      } catch { /* keep defaults */ }
    }
    /* otherwise keep defaults */
  }

  // Platform fee = pct of subtotal (NOT of subtotal + shipping, so
  // we don't take a cut of pass-through shipping costs). Math from
  // the shared helper so /api/external/checkout.js can't disagree.
  const platformFeeCents = calcPlatformFeeCents(subtotalCents, feePct);

  // Target the storefront's destination charge must receive BEFORE
  // Stripe takes its cut. The customer pays this + any Stripe pass-
  // through on top. Components received here:
  //   subtotal_cents      → tenant
  //   shipping_cents      → tenant (label-cost pass-through)
  //   platform_fee_cents  → GoElev8
  //   processing_fee_cents→ GoElev8 (covers low-cart Stripe overhead)
  const targetReceived = subtotalCents + platformFeeCents + processingFeeCents + shippingCents;

  let customerTotalCents, stripeFeeCents;
  if (passStripeFees) {
    const r = applyStripePassThrough(targetReceived);
    customerTotalCents = r.customer;
    stripeFeeCents     = r.stripeFee;
  } else {
    customerTotalCents = targetReceived;
    stripeFeeCents     = 0;  // not passed — tenant absorbs from their margin
  }

  // Tenant's takehome = subtotal (their listed price) + shipping
  // collected. Platform takes platform_fee_cents + processing_fee_cents;
  // Stripe takes its processing fee from the surcharge.
  const tenantTakehome = subtotalCents + shippingCents;

  // Amount the storefront must pass as application_fee_amount on its
  // Stripe Connect destination charge — everything that should NOT
  // hit the tenant's connected account.
  const applicationFeeCents = platformFeeCents + processingFeeCents + stripeFeeCents;

  return res.status(200).json({
    platform_fee_pct:             feePct,
    platform_fee_cents:           platformFeeCents,
    processing_fee_cents:         processingFeeCents,
    stripe_fee_cents:             stripeFeeCents,
    application_fee_cents:        applicationFeeCents,
    subtotal_cents:               subtotalCents,
    shipping_cents:               shippingCents,
    customer_total_cents:         customerTotalCents,
    tenant_takehome_cents:        tenantTakehome,
    pass_stripe_fees_to_customer: passStripeFees,
    // Connected Stripe account ID — storefront uses this as
    // transfer_data.destination on its PaymentIntent so the tenant
    // (Will / Kenny / Nate) is paid into their own Stripe account
    // and the application_fee_amount stays with GoElev8.
    stripe_connected_account_id:  connectedAccountId
  });
}
