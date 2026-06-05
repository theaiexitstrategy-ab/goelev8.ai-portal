// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// External order receiver — called by a tenant's marketing storefront
// (e.g. willpowerfitnessfactory.com/merch) AFTER a Stripe checkout
// completes and Printify fulfillment runs. The portal stores the
// order under the tenant for the operator's dashboard.
//
// Auth: Authorization: Bearer <clients.portal_api_key>
//   Each tenant's portal_api_key is provisioned in Master Admin and
//   pasted into their storefront's PORTAL_API_KEY env var.
//
// Idempotent on stripe_payment_id — re-POSTing the same order (e.g.
// from a webhook backup path) is a no-op that returns the existing
// order id.
//
// POST /api/external/orders
// Body shape (matches willpowerfitnessfactory's syncOrderToPortal):
//   {
//     customer_name, customer_email,
//     shipping: { name, address1, address2, city, state, zip, country },
//     items: [{ product_id, name, color, size, quantity, price_cents }],
//     subtotal_cents, shipping_cents, total_cents,
//     stripe_payment_id, printify_order_id?, external_order_number?,
//     coupon_code?, discount_cents?
//   }

import { supabaseAdmin } from '../../lib/supabase.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type'
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

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Resolve the tenant from the Bearer API key. The key lives on the
  // clients row (clients.portal_api_key) so each tenant's storefront
  // can only write orders under its own row.
  const auth = String(req.headers['authorization'] || '');
  const apiKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!apiKey) return res.status(401).json({ error: 'missing_bearer_token' });

  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients').select('id, slug, name').eq('portal_api_key', apiKey).maybeSingle();
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client)   return res.status(401).json({ error: 'invalid_api_key' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const stripePaymentId = String(body?.stripe_payment_id || '').trim();
  if (!stripePaymentId) return res.status(400).json({ error: 'stripe_payment_id required' });

  // Idempotency — if we've already recorded this Stripe PI, return
  // the existing order id with a 200. Storefront retries (webhook
  // backup path firing after the success path, network blips) are
  // safe to ignore.
  {
    const { data: existing } = await supabaseAdmin
      .from('merch_orders').select('id, client_id, created_at')
      .eq('stripe_payment_id', stripePaymentId).maybeSingle();
    if (existing) {
      return res.status(200).json({
        ok: true,
        order_id: existing.id,
        idempotent: true,
        created_at: existing.created_at
      });
    }
  }

  const shipping = body?.shipping || {};
  const items    = Array.isArray(body?.items) ? body.items : [];

  const orderRow = {
    client_id:             client.id,
    customer_name:         body?.customer_name || shipping?.name || null,
    customer_email:        body?.customer_email || null,
    customer_phone:        body?.customer_phone || null,
    shipping_address1:     shipping?.address1 || null,
    shipping_address2:     shipping?.address2 || null,
    shipping_city:         shipping?.city || null,
    shipping_state:        shipping?.state || null,
    shipping_zip:          shipping?.zip || null,
    shipping_country:      shipping?.country || 'US',
    subtotal_cents:        Number.isFinite(+body?.subtotal_cents) ? +body.subtotal_cents : 0,
    shipping_cents:        Number.isFinite(+body?.shipping_cents) ? +body.shipping_cents : 0,
    discount_cents:        Number.isFinite(+body?.discount_cents) ? +body.discount_cents : 0,
    total_cents:           Number.isFinite(+body?.total_cents)    ? +body.total_cents    : 0,
    // Platform fee + flat processing fee + Stripe pass-through, all
    // reported by the storefront after it quoted /api/external/fees/quote.
    // The portal uses these to surface a per-order ledger and (with
    // Stripe Connect) to reconcile application_fee_amount against
    // actual takes.
    platform_fee_cents:    Number.isFinite(+body?.platform_fee_cents)   ? +body.platform_fee_cents   : 0,
    processing_fee_cents:  Number.isFinite(+body?.processing_fee_cents) ? +body.processing_fee_cents : 0,
    stripe_fee_cents:      Number.isFinite(+body?.stripe_fee_cents)     ? +body.stripe_fee_cents     : 0,
    coupon_code:           body?.coupon_code ? String(body.coupon_code).toUpperCase() : null,
    stripe_payment_id:     stripePaymentId,
    printify_order_id:     body?.printify_order_id || null,
    external_order_number: body?.external_order_number || null,
    status:                'paid'
  };

  // First try with the fee columns; if they don't exist yet (migration
  // hasn't been applied on this project), retry without them so the
  // order sync doesn't break.
  let inserted, insErr;
  {
    const r = await supabaseAdmin.from('merch_orders').insert(orderRow).select('id').single();
    inserted = r.data; insErr = r.error;
  }
  if (insErr && /column .*(platform_fee_cents|processing_fee_cents|stripe_fee_cents).* does not exist/i.test(insErr.message)) {
    const legacy = { ...orderRow };
    delete legacy.platform_fee_cents;
    delete legacy.processing_fee_cents;
    delete legacy.stripe_fee_cents;
    const r2 = await supabaseAdmin.from('merch_orders').insert(legacy).select('id').single();
    inserted = r2.data; insErr = r2.error;
  }
  if (insErr) return res.status(500).json({ error: 'order_insert_failed: ' + insErr.message });

  if (items.length) {
    const lineRows = items.map(it => ({
      order_id:    inserted.id,
      product_key: it?.product_id ? String(it.product_id) : (it?.product_key || null),
      name:        it?.name || null,
      color:       it?.color || null,
      size:        it?.size || null,
      quantity:    Number.isFinite(+it?.quantity) ? +it.quantity : 1,
      price_cents: Number.isFinite(+it?.price_cents) ? +it.price_cents : 0
    }));
    const { error: itemsErr } = await supabaseAdmin
      .from('merch_order_items').insert(lineRows);
    if (itemsErr) {
      // Roll the order back so a partial write doesn't masquerade as
      // a real fulfilled order with no line items in the operator UI.
      await supabaseAdmin.from('merch_orders').delete().eq('id', inserted.id);
      return res.status(500).json({ error: 'order_items_insert_failed: ' + itemsErr.message });
    }
  }

  // Bump the coupon's used_count if one was applied. Best-effort —
  // ignored if the coupon was deleted between checkout and sync.
  if (orderRow.coupon_code) {
    try {
      const { data: c } = await supabaseAdmin.from('merch_coupons')
        .select('id, used_count')
        .eq('client_id', client.id).eq('code', orderRow.coupon_code).maybeSingle();
      if (c) {
        await supabaseAdmin.from('merch_coupons')
          .update({ used_count: (c.used_count || 0) + 1 })
          .eq('id', c.id);
      }
    } catch { /* non-fatal */ }
  }

  return res.status(200).json({
    ok: true,
    order_id: inserted.id,
    client: { slug: client.slug, name: client.name }
  });
}
