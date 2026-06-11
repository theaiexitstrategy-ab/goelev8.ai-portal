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
// The session is created against the *client's own* Stripe account
// using clients.stripe_secret_key — money flows to the tenant, not to
// the platform. If the tenant hasn't configured a Stripe key yet, we
// return a clear 400 so the storefront can surface a useful error
// (instead of a cryptic Stripe 401).
//
// CORS is open — storefronts call this from the browser. The endpoint
// validates the slug + product_key against our own DB and uses *our*
// stored price (not anything the caller sent), so a hostile caller
// can't fabricate a $0 line item.

import Stripe from 'stripe';
import { supabaseAdmin } from '../../lib/supabase.js';

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

  // Resolve tenant + their Stripe key.
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients').select('id, slug, name, stripe_secret_key').eq('slug', slug).maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client)   return res.status(404).json({ error: 'tenant_not_found' });
  if (!client.stripe_secret_key) {
    return res.status(400).json({
      error: 'stripe_not_configured',
      message: 'This storefront is not connected to Stripe yet. The operator needs to set a Stripe secret key in the portal before checkout will work.'
    });
  }

  // Resolve product. We deliberately read the current row at click
  // time so the price the customer pays is whatever's in the portal
  // right now — that's the whole point of this endpoint.
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
    return res.status(400).json({ error: 'invalid_price', message: 'Product price is not set in the portal.' });
  }

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

  const tenantStripe = new Stripe(client.stripe_secret_key, { apiVersion: '2024-06-20' });

  try {
    const session = await tenantStripe.checkout.sessions.create({
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
      metadata: {
        portal_client_id:  client.id,
        portal_product_id: product.id,
        client_slug:       client.slug,
        product_key:       productKey,
        source:            'portal_external_checkout'
      }
    });
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
