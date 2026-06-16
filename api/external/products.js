// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Public read of the active product list for a tenant's storefront.
// No auth required — the storefront calls this from the browser to
// render prices, names, and images. Operator-only fields (printify
// product id) are stripped from the response.
//
// GET /api/external/products?slug=willpower-fitness
//   → { products: [{ key, name, description, price_cents,
//                    compare_at_price_cents, image_url, payment_link,
//                    sort_order }, ...] }
//
// `payment_link` is an optional Stripe Payment Link URL the operator
// pastes via the portal merch admin. When present, the tenant's
// storefront routes the Buy button straight to Stripe-hosted checkout
// instead of any in-house cart.

import { supabaseAdmin } from '../../lib/supabase.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug query param required' });

  const { data: client } = await supabaseAdmin
    .from('clients').select('id').eq('slug', slug).maybeSingle();
  if (!client) return res.status(404).json({ error: 'tenant_not_found' });

  let { data, error } = await supabaseAdmin
    .from('merch_products')
    .select('product_key, name, description, base_price_cents, compare_at_price_cents, image_url, payment_link, sort_order, colors')
    .eq('client_id', client.id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  // Tolerant retry without `colors` for projects where the migration
  // hasn't been applied yet.
  if (error && /column .*colors.* does not exist/i.test(error.message || '')) {
    const retry = await supabaseAdmin
      .from('merch_products')
      .select('product_key, name, description, base_price_cents, compare_at_price_cents, image_url, payment_link, sort_order')
      .eq('client_id', client.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true });
    data = retry.data; error = retry.error;
  }
  // Tolerant if migration hasn't been applied yet — empty list keeps
  // the storefront's existing hardcoded fallback usable.
  if (error && /relation .*merch_products.* does not exist/i.test(error.message)) {
    return res.status(200).json({ products: [], setup_required: true });
  }
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({
    products: (data || []).map(p => ({
      key:                    p.product_key,
      name:                   p.name,
      description:            p.description,
      price_cents:            p.base_price_cents,
      compare_at_price_cents: p.compare_at_price_cents,
      image_url:              p.image_url,
      // Array of { name, image_url } when the operator set color
      // variants in the portal; empty array otherwise. Storefronts
      // render swatches when non-empty.
      colors:                 Array.isArray(p.colors) ? p.colors : [],
      payment_link:           p.payment_link,
      sort_order:             p.sort_order
    }))
  });
}
