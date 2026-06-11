// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Public Stripe Checkout Session creator. Lets a tenant's marketing
// site (e.g. islaystudiosllc.com/merch) hand off "Buy" clicks to a
// fully Stripe-hosted checkout without standing up its own cart, AND
// without the operator having to create products / Payment Links in
// the Stripe dashboard. The price comes straight from the portal's
// merch_products row at click time, so editing a price in the merch
// admin takes effect on the next purchase — no Stripe-side sync.
//
// POST /api/external/checkout
//   Body: {
//     slug:         "islay-studios",          // required
//     product_key:  "shampoo",                // required (must be is_active=true)
//     quantity:     1,                        // optional, default 1, max 99
//     success_url:  "https://…/merch?paid=1", // optional
//     cancel_url:   "https://…/merch"         // optional
//   }
//   Response: { url: "https://checkout.stripe.com/c/pay/…" }
//
// Money flow — Stripe Connect direct charges:
//   - The session is created on the platform's Stripe API key but
//     scoped to the tenant's connected account via the second arg
//     `{ stripeAccount: <acct_xxx> }`. Funds settle into the tenant's
//     Stripe balance.
//   - application_fee_amount routes the platform's cut (10% by default,
//     overridable per tenant via clients.platform_fee_pct — see
//     lib/platform-fee.js) to GoElev8 in the same charge.
//   - The tenant connects their Stripe in the portal Integrations
//     panel (api/portal/connect.js OAuth flow); their account id is
//     persisted as clients.stripe_connected_account_id. Storefront
//     never sees that id.
//
// CORS is open — storefronts call this from the browser. The endpoint
// validates the slug + product_key against our own DB and uses *our*
// stored price (not anything the caller sent), so a hostile caller
// can't fabricate a $0 line item.

import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import {
  resolvePlatformFeePct,
  calcPlatformFeeCents
} from '../../lib/platform-fee.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

function setCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function isHttpUrl(s) {
  if (typeof s !== 'string' || !s) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const slug       = String(body?.slug || '').trim();
  const productKey = String(body?.product_key || '').trim();
  if (!slug)       return res.status(400).json({ error: 'slug required' });
  if (!productKey) return res.status(400).json({ error: 'product_key required' });

  // Quantity — accept 1..99 (an upper cap that's plenty for retail
  // merch and stops a hostile caller from generating a $$$ line item
  // that ties up a Stripe session id).
  let quantity = Number.isFinite(+body?.quantity) ? Math.floor(+body.quantity) : 1;
  if (quantity < 1)  quantity = 1;
  if (quantity > 99) quantity = 99;

  // Resolve tenant + their Connect account + per-tenant fee override.
  // platform_fee_pct may be NULL → resolvePlatformFeePct falls back to
  // the env default (10% as of writing).
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, stripe_connected_account_id, platform_fee_pct')
    .eq('slug', slug)
    .maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client)   return res.status(404).json({ error: 'tenant_not_found' });

  // Resolve product BEFORE the Connect gate. Order matters — a stale
  // storefront still pointing at a removed/inactive SKU should get
  // the specific 404 product_not_found, not a misleading
  // stripe_not_configured.
  const { data: product, error: productErr } = await supabaseAdmin
    .from('merch_products')
    .select('id, name, description, base_price_cents, image_url, is_active')
    .eq('client_id', client.id)
    .eq('product_key', productKey)
    .maybeSingle();
  if (productErr) return res.status(500).json({ error: productErr.message });
  if (!product || !product.is_active) {
    return res.status(404).json({ error: 'product_not_found' });
  }
  const unitAmount = Number(product.base_price_cents);
  if (!Number.isFinite(unitAmount) || unitAmount < 1) {
    return res.status(400).json({
      error: 'invalid_price',
      message: 'Product price is not set in the portal.'
    });
  }

  // Now the Connect gate. The tenant must have completed the OAuth
  // flow in the portal Integrations panel before any direct charge
  // can be routed to their account.
  if (!client.stripe_connected_account_id) {
    return res.status(400).json({
      error: 'stripe_not_configured',
      message: 'This storefront has not connected its Stripe account yet. The operator needs to open the portal Integrations panel and click Connect Stripe before checkout will work.'
    });
  }

  // Platform fee. Subtotal here is what the customer will pay for the
  // line item; we don't add shipping or processing fee surcharges on
  // top — those land in the destination charge as additional line
  // items if the storefront opts in (out of scope for this endpoint).
  const subtotalCents = unitAmount * quantity;
  const platformFeePct = resolvePlatformFeePct(client);
  const applicationFeeCents = calcPlatformFeeCents(subtotalCents, platformFeePct);

  // success_url / cancel_url — caller's choice when provided, with a
  // sane fallback derived from the request Origin (or, failing that,
  // a generic placeholder Stripe will accept).
  const origin = String(req.headers['origin'] || '').replace(/\/+$/, '');
  const successUrl = isHttpUrl(body?.success_url)
    ? body.success_url
    : (origin ? origin + '/merch?paid=1&session_id={CHECKOUT_SESSION_ID}' : 'https://example.com/?paid=1');
  const cancelUrl = isHttpUrl(body?.cancel_url)
    ? body.cancel_url
    : (origin ? origin + '/merch' : 'https://example.com/');

  // Shared metadata, mirrored onto the Checkout Session AND the
  // underlying PaymentIntent so:
  //   - /api/external/orders (the storefront-side post-purchase POST)
  //     can resolve which portal tenant + product this charge came from
  //   - sync-sales (which iterates PaymentIntents on the connected
  //     account, not Sessions) can reconcile without re-loading anything
  // Values must be strings — Stripe rejects non-string metadata.
  const sharedMetadata = {
    portal_client_id:   String(client.id),
    portal_product_id:  String(product.id),
    client_slug:        String(client.slug),
    product_key:        productKey,
    platform_fee_cents: String(applicationFeeCents),
    source:             'portal_external_checkout'
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // Ad-hoc line item: no Stripe Product or Price object required.
      // Name, description, and image come from the portal so the
      // checkout page matches what the customer just clicked.
      line_items: [{
        quantity,
        price_data: {
          currency: 'usd',
          unit_amount: unitAmount,
          product_data: {
            name: product.name,
            description: product.description || undefined,
            images: product.image_url ? [product.image_url] : []
          }
        }
      }],
      // Physical merch — collect shipping address and a phone number
      // so the tenant can fulfill. Shipping rates are not configured
      // here; the operator can wire them up in Stripe later or layer
      // a flat per-tenant rate on top of this endpoint.
      shipping_address_collection: { allowed_countries: ['US'] },
      phone_number_collection: { enabled: true },
      allow_promotion_codes: true,
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_intent_data: {
        application_fee_amount: applicationFeeCents,
        metadata: sharedMetadata
      },
      metadata: sharedMetadata
    }, { stripeAccount: client.stripe_connected_account_id });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    // Stripe's own error messages are usually clear enough for the
    // operator to act on, so we surface them. Keep status 502 so the
    // storefront can distinguish "Stripe rejected us" from a 400 on
    // its own request payload.
    const msg = e?.message || 'stripe_error';
    return res.status(502).json({ error: 'stripe_error', message: msg });
  }
}
