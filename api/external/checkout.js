// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Public Stripe Checkout Session creator. Lets a tenant's marketing
// site (e.g. islaystudiosllc.com/merch, theflexfacility.com/merch,
// willpowerfitnessfactory.com/merch) hand off "Buy" clicks to a
// fully Stripe-hosted checkout without standing up its own cart, AND
// without the operator having to create products / Payment Links in
// the Stripe dashboard. The price comes straight from the portal's
// merch_products row at click time, so editing a price in the merch
// admin takes effect on the next purchase — no Stripe-side sync.
//
// POST /api/external/checkout
//
// Two body shapes are supported:
//
//   Single-item (backward-compatible with islaystudiosllc.com):
//     {
//       slug:         "islay-studios",          // required
//       product_key:  "shampoo",                // required (must be is_active=true)
//       quantity:     1,                        // optional, default 1, max 99
//       variant:      { size: "M", color: "Black" },  // optional
//       success_url:  "https://…/merch?paid=1", // optional
//       cancel_url:   "https://…/merch"         // optional
//     }
//
//   Multi-item (theflexfacility.com / willpowerfitnessfactory.com carts):
//     {
//       slug:       "flex-facility",
//       items: [
//         { product_key: "hoodie-black-cyan", quantity: 1, variant: { size: "L" } },
//         { product_key: "snapback",          quantity: 2 }
//       ],
//       success_url, cancel_url
//     }
//
//   When `items` is provided it takes precedence. When only product_key
//   is provided we synthesize a single-element array internally.
//
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
// validates the slug + product_keys against our own DB and uses *our*
// stored prices (not anything the caller sent), so a hostile caller
// can't fabricate a $0 line item.

import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import {
  resolvePlatformFeePct,
  calcPlatformFeeCents
} from '../../lib/platform-fee.js';

// Flat processing fee charged to every customer on top of subtotal.
// Mirrors PROCESSING_FEE_DEFAULT_CENTS in api/external/fees.js. Falls
// back to $3 if the env var isn't set. This goes to GoElev8 via the
// application_fee_amount, not to the tenant.
const PROCESSING_FEE_CENTS = parseInt(process.env.PROCESSING_FEE_DEFAULT_CENTS || '300', 10);

// Shipping rate menu shown on the Stripe Checkout page. Stripe
// renders these as radio buttons under the customer's shipping
// address; whichever they pick is added to the session total and
// captured into session.total_details.amount_shipping (which the
// portal webhook → merch_orders → shipping_cents flow records).
//
// Free shipping is enabled automatically when subtotal >= the
// threshold below — we pass the conditional rate to Stripe instead
// of computing two separate session shapes.
const FREE_SHIPPING_THRESHOLD_CENTS = parseInt(process.env.FREE_SHIPPING_THRESHOLD_CENTS || '7500', 10);

function buildShippingOptions(subtotalCents) {
  const options = [];

  if (subtotalCents >= FREE_SHIPPING_THRESHOLD_CENTS) {
    options.push({
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 0, currency: 'usd' },
        display_name: 'Free Standard Shipping',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 3 },
          maximum: { unit: 'business_day', value: 7 }
        }
      }
    });
  } else {
    options.push({
      shipping_rate_data: {
        type: 'fixed_amount',
        fixed_amount: { amount: 700, currency: 'usd' },
        display_name: 'USPS Priority (3–5 business days)',
        delivery_estimate: {
          minimum: { unit: 'business_day', value: 3 },
          maximum: { unit: 'business_day', value: 5 }
        }
      }
    });
  }

  // Expedited tier — always available as a paid upgrade so customers
  // who need it sooner have a choice. Customer's actual address gets
  // captured in session.shipping_details.address so the tenant can
  // print whatever label they want at fulfillment time.
  options.push({
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: 1900, currency: 'usd' },
      display_name: 'USPS Express (1–3 business days)',
      delivery_estimate: {
        minimum: { unit: 'business_day', value: 1 },
        maximum: { unit: 'business_day', value: 3 }
      }
    }
  });

  return options;
}

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

// Normalize either body shape into a single internal array.
// Returns { items, error } — error is a { status, body } for early
// 400s; items is an array of { product_key, quantity, variant }.
function normalizeRequestedItems(body) {
  if (Array.isArray(body?.items) && body.items.length) {
    if (body.items.length > 20) return { error: { status: 400, body: { error: 'too_many_items' } } };
    const out = [];
    for (const raw of body.items) {
      const key = String(raw?.product_key || '').trim();
      if (!key) return { error: { status: 400, body: { error: 'item_product_key_required' } } };
      let qty = Number.isFinite(+raw?.quantity) ? Math.floor(+raw.quantity) : 1;
      if (qty < 1)  qty = 1;
      if (qty > 99) qty = 99;
      out.push({ product_key: key, quantity: qty, variant: sanitizeVariant(raw?.variant) });
    }
    return { items: out };
  }
  // Single-item legacy shape
  const key = String(body?.product_key || '').trim();
  if (!key) return { error: { status: 400, body: { error: 'product_key required' } } };
  let qty = Number.isFinite(+body?.quantity) ? Math.floor(+body.quantity) : 1;
  if (qty < 1)  qty = 1;
  if (qty > 99) qty = 99;
  return { items: [{ product_key: key, quantity: qty, variant: sanitizeVariant(body?.variant) }] };
}

// Variant must be plain { size?, color? } strings — strip everything
// else so a hostile caller can't smuggle huge metadata payloads
// through the Stripe 500-char limit.
function sanitizeVariant(v) {
  if (!v || typeof v !== 'object') return null;
  const size  = v.size  != null ? String(v.size).trim().slice(0, 24)  : null;
  const color = v.color != null ? String(v.color).trim().slice(0, 32) : null;
  if (!size && !color) return null;
  return { size: size || null, color: color || null };
}

// Build the visible name shown in Stripe Checkout. Includes variant
// pieces in a "Product — Size M · Black" suffix so the customer sees
// exactly what they're paying for.
function buildLineName(productName, variant) {
  if (!variant) return productName;
  const parts = [];
  if (variant.size)  parts.push(`Size ${variant.size}`);
  if (variant.color) parts.push(variant.color);
  return parts.length ? `${productName} — ${parts.join(' · ')}` : productName;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const slug = String(body?.slug || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const norm = normalizeRequestedItems(body);
  if (norm.error) return res.status(norm.error.status).json(norm.error.body);
  const requestedItems = norm.items;

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

  // Resolve every requested product against merch_products. Order
  // matters — product lookup runs BEFORE the Connect gate so a stale
  // storefront still pointing at a removed/inactive SKU gets the
  // specific 404 product_not_found, not a misleading
  // stripe_not_configured.
  const productKeys = requestedItems.map(it => it.product_key);
  const { data: products, error: productErr } = await supabaseAdmin
    .from('merch_products')
    .select('id, product_key, name, description, base_price_cents, image_url, is_active')
    .eq('client_id', client.id)
    .in('product_key', productKeys);
  if (productErr) return res.status(500).json({ error: productErr.message });

  const productByKey = new Map();
  for (const p of (products || [])) productByKey.set(p.product_key, p);

  // Hydrate each requested item with its resolved product row. Bail
  // on the first miss so the caller gets a precise error.
  const lineRows = [];
  let subtotalCents = 0;
  for (const it of requestedItems) {
    const p = productByKey.get(it.product_key);
    if (!p || !p.is_active) {
      return res.status(404).json({ error: 'product_not_found', product_key: it.product_key });
    }
    const unit = Number(p.base_price_cents);
    if (!Number.isFinite(unit) || unit < 1) {
      return res.status(400).json({
        error: 'invalid_price',
        product_key: it.product_key,
        message: 'Product price is not set in the portal.'
      });
    }
    lineRows.push({ ...it, product: p, unit_amount: unit });
    subtotalCents += unit * it.quantity;
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

  const platformFeePct = resolvePlatformFeePct(client);
  const platformFeeCents = calcPlatformFeeCents(subtotalCents, platformFeePct);

  // application_fee_amount = the share that goes to GoElev8 instead of
  // the tenant. We collect:
  //   - platform_fee_cents (10% of subtotal, configurable per-tenant)
  //   - PROCESSING_FEE_CENTS ($3 flat, customer-visible line item)
  // Shipping is NOT in here — whatever the customer picks for shipping
  // settles into the tenant's Stripe balance so they can pay for the
  // actual label/box at fulfillment time.
  const processingFeeCents = PROCESSING_FEE_CENTS;
  const applicationFeeCents = platformFeeCents + processingFeeCents;

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

  // Stripe line_items — one per requested item. Variant shows in the
  // product name suffix so the customer sees it on the checkout page.
  const stripeLineItems = lineRows.map(it => ({
    quantity: it.quantity,
    price_data: {
      currency: 'usd',
      unit_amount: it.unit_amount,
      product_data: {
        name: buildLineName(it.product.name, it.variant),
        description: it.product.description || undefined,
        images: it.product.image_url ? [it.product.image_url] : []
      }
    }
  }));

  // Customer-visible processing fee line. Shown on the Stripe Checkout
  // summary so there's no surprise total — the buyer can see exactly
  // what they're paying for. application_fee_amount above already
  // routes this $3 to GoElev8, so adding it as a line item just makes
  // the breakdown transparent (Stripe doesn't care about the split).
  if (processingFeeCents > 0) {
    stripeLineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: processingFeeCents,
        product_data: {
          name: 'Processing fee',
          description: 'Covers card processing and platform overhead.'
        }
      }
    });
  }

  // Compact per-line payload for the webhook. Stripe metadata values
  // are capped at 500 chars each, so we omit anything non-essential
  // (name/description — re-derivable from product_id at ingest time).
  const itemsManifest = lineRows.map(it => ({
    k: it.product_key,
    p: String(it.product.id),
    q: it.quantity,
    s: it.variant?.size  || null,
    c: it.variant?.color || null
  }));

  // Shared metadata, mirrored onto the Checkout Session AND the
  // underlying PaymentIntent so:
  //   - lib/merch-ingest.js (the Stripe webhook → merch_orders path)
  //     can resolve which portal tenant + product + variant produced
  //     each line item without re-loading the session
  //   - api/external/orders (the legacy storefront-side POST path) can
  //     still reconcile against the same keys it always has
  //   - sync-sales (PaymentIntent iteration) sees the breakdown too
  // Values must be strings — Stripe rejects non-string metadata.
  const isMulti = lineRows.length > 1;
  const sharedMetadata = {
    portal_client_id:     String(client.id),
    portal_product_id:    isMulti ? '' : String(lineRows[0].product.id),
    client_slug:          String(client.slug),
    product_key:          isMulti ? '' : lineRows[0].product_key,
    // Split the GoElev8 cut so the webhook can persist each piece
    // separately to merch_orders.platform_fee_cents +
    // merch_orders.processing_fee_cents and reconciliation reports
    // can tell them apart.
    platform_fee_cents:   String(platformFeeCents),
    processing_fee_cents: String(processingFeeCents),
    application_fee_cents: String(applicationFeeCents),
    source:               'portal_external_checkout',
    items_json:           JSON.stringify(itemsManifest).slice(0, 480),
    // Variant breakout for the single-item path so consumers that
    // don't parse items_json still see the variant the buyer picked.
    variant_size:         isMulti ? '' : (lineRows[0].variant?.size  || ''),
    variant_color:        isMulti ? '' : (lineRows[0].variant?.color || '')
  };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: stripeLineItems,
      // Physical merch — collect shipping address and a phone number
      // so the tenant can fulfill. shipping_options below presents the
      // customer with the rate picker (USPS Priority / Express, plus
      // free shipping over $75); whichever they pick is added to the
      // total and captured into session.total_details.amount_shipping.
      shipping_address_collection: { allowed_countries: ['US'] },
      shipping_options: buildShippingOptions(subtotalCents),
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
