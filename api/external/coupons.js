// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Public coupon validation for a tenant's storefront. The storefront
// POSTs the code + the current cart subtotal; the portal answers
// whether the code is valid AND what discount to apply.
//
// Stateless from a usage-count perspective — used_count is bumped
// later when /api/external/orders writes the completed order. That
// keeps validation cheap and idempotent for cart re-renders.
//
// POST /api/external/coupons/validate
//   Body: { slug: 'willpower-fitness', code: 'SUMMER20', subtotal_cents: 4499 }
//   →     { valid: true, code, discount_type, discount_value,
//           discount_cents (computed against subtotal), name, expires_at }
//     or  { valid: false, reason: 'expired'|'not_found'|'inactive'|'below_minimum'|'exhausted' }

import { supabaseAdmin } from '../../lib/supabase.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

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
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const slug          = String(body?.slug || '').trim();
  const code          = String(body?.code || '').trim().toUpperCase();
  const subtotalCents = Number.isFinite(+body?.subtotal_cents) ? +body.subtotal_cents : 0;
  if (!slug || !code) return res.status(400).json({ valid: false, reason: 'missing_fields' });

  const { data: client } = await supabaseAdmin
    .from('clients').select('id').eq('slug', slug).maybeSingle();
  if (!client) return res.status(200).json({ valid: false, reason: 'tenant_not_found' });

  const { data: coupon, error } = await supabaseAdmin
    .from('merch_coupons')
    .select('*').eq('client_id', client.id).eq('code', code).maybeSingle();
  if (error && /relation .*merch_coupons.* does not exist/i.test(error.message)) {
    return res.status(200).json({ valid: false, reason: 'not_found' });
  }
  if (error)   return res.status(500).json({ error: error.message });
  if (!coupon) return res.status(200).json({ valid: false, reason: 'not_found' });
  if (!coupon.is_active) return res.status(200).json({ valid: false, reason: 'inactive' });
  if (coupon.expires_at && new Date(coupon.expires_at).getTime() < Date.now()) {
    return res.status(200).json({ valid: false, reason: 'expired' });
  }
  if (coupon.max_uses != null && coupon.used_count >= coupon.max_uses) {
    return res.status(200).json({ valid: false, reason: 'exhausted' });
  }
  if (coupon.min_subtotal_cents != null && subtotalCents < coupon.min_subtotal_cents) {
    return res.status(200).json({
      valid: false, reason: 'below_minimum',
      min_subtotal_cents: coupon.min_subtotal_cents
    });
  }

  // Compute discount cents against the supplied subtotal so the
  // storefront can show the final price without an extra round trip.
  let discountCents = 0;
  if (coupon.discount_type === 'percent') {
    discountCents = Math.floor((subtotalCents * coupon.discount_value) / 100);
  } else if (coupon.discount_type === 'fixed') {
    discountCents = Math.min(coupon.discount_value, subtotalCents);
  }

  return res.status(200).json({
    valid: true,
    code: coupon.code,
    name: coupon.name,
    discount_type: coupon.discount_type,
    discount_value: coupon.discount_value,
    discount_cents: discountCents,
    expires_at: coupon.expires_at
  });
}
