// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Portal-side Merch management. Single endpoint with ?action= so the
// SPA can drive Products / Coupons / Orders from one network namespace.
// All queries scoped to ctx.clientId — tenants can only see/edit their
// own rows.
//
// Actions (GET):
//   ?action=summary          — counts + recent orders for the tab header
//   ?action=list-products
//   ?action=list-coupons
//   ?action=list-orders
//   ?action=order-detail&id=...   (includes line items)
//
// Actions (POST/PATCH):
//   ?action=upsert-product   — body: { product_key (required on insert), name, ... }
//   ?action=delete-product   — body: { id }
//   ?action=upsert-coupon    — body: { code (required), discount_type, discount_value, ... }
//   ?action=delete-coupon    — body: { id }
//   ?action=refund-order     — body: { id } (status='refunded'; no Stripe refund — operator manual)

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const VALID_DISCOUNT_TYPES = ['percent', 'fixed'];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  if (!ctx.clientId) return res.status(403).json({ error: 'no_client_context' });

  const url = new URL(req.url, 'http://x');
  const action = (url.searchParams.get('action') || '').trim();

  try {
    if (req.method === 'GET') {
      if (action === 'summary')         return await summary(res, ctx.clientId);
      if (action === 'list-products')   return await listProducts(res, ctx.clientId);
      if (action === 'list-coupons')    return await listCoupons(res, ctx.clientId);
      if (action === 'list-orders')     return await listOrders(res, ctx.clientId);
      if (action === 'order-detail')    return await orderDetail(res, ctx.clientId, url.searchParams.get('id'));
      return res.status(400).json({ error: 'unknown_action' });
    }

    const body = await readJson(req);
    if (action === 'upsert-product') return await upsertProduct(res, ctx.clientId, body);
    if (action === 'delete-product') return await deleteProduct(res, ctx.clientId, body);
    if (action === 'upsert-coupon')  return await upsertCoupon(res, ctx.clientId, body);
    if (action === 'delete-coupon')  return await deleteCoupon(res, ctx.clientId, body);
    if (action === 'refund-order')   return await refundOrder(res, ctx.clientId, body);
    if (action === 'upload-image')   return await uploadImage(res, ctx.clientId, body);
    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ──────────────────────────────────────────────────────────────
// Tolerant query — returns { setup_required: true } instead of
// erroring when the merch_* migration hasn't been applied yet, so
// the Merch tab renders an actionable empty state.
// ──────────────────────────────────────────────────────────────
function tableMissing(err, table) {
  return err && new RegExp(`relation .*${table}.* does not exist`, 'i').test(err.message);
}

// GET ──────────────────────────────────────────────────────────
async function summary(res, clientId) {
  const [products, coupons, orders] = await Promise.all([
    supabaseAdmin.from('merch_products').select('id', { count: 'exact', head: true }).eq('client_id', clientId),
    supabaseAdmin.from('merch_coupons').select('id', { count: 'exact', head: true }).eq('client_id', clientId).eq('is_active', true),
    supabaseAdmin.from('merch_orders').select('id, total_cents, status, created_at').eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(5)
  ]);
  if (tableMissing(products.error, 'merch_products')) {
    return res.status(200).json({ setup_required: true, counts: { products: 0, active_coupons: 0, orders: 0 }, revenue_cents: 0, recent_orders: [] });
  }
  const counts = {
    products: products.count || 0,
    active_coupons: coupons.count || 0,
    orders: orders.data?.length || 0
  };
  const { count: orderCount } = await supabaseAdmin.from('merch_orders')
    .select('id', { count: 'exact', head: true }).eq('client_id', clientId);
  counts.orders = orderCount || 0;
  const { data: paidOrders } = await supabaseAdmin.from('merch_orders')
    .select('total_cents').eq('client_id', clientId).neq('status', 'refunded');
  const revenueCents = (paidOrders || []).reduce((s, o) => s + (o.total_cents || 0), 0);
  return res.status(200).json({ counts, revenue_cents: revenueCents, recent_orders: orders.data || [] });
}

async function listProducts(res, clientId) {
  const { data, error } = await supabaseAdmin.from('merch_products')
    .select('*').eq('client_id', clientId)
    .order('sort_order', { ascending: true }).order('name', { ascending: true });
  if (tableMissing(error, 'merch_products')) return res.status(200).json({ products: [], setup_required: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ products: data || [] });
}

async function listCoupons(res, clientId) {
  const { data, error } = await supabaseAdmin.from('merch_coupons')
    .select('*').eq('client_id', clientId).order('created_at', { ascending: false });
  if (tableMissing(error, 'merch_coupons')) return res.status(200).json({ coupons: [], setup_required: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ coupons: data || [] });
}

async function listOrders(res, clientId) {
  const { data, error } = await supabaseAdmin.from('merch_orders')
    .select('*').eq('client_id', clientId).order('created_at', { ascending: false }).limit(200);
  if (tableMissing(error, 'merch_orders')) return res.status(200).json({ orders: [], setup_required: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ orders: data || [] });
}

async function orderDetail(res, clientId, id) {
  if (!id) return res.status(400).json({ error: 'id required' });
  const { data: order } = await supabaseAdmin.from('merch_orders')
    .select('*').eq('id', id).eq('client_id', clientId).maybeSingle();
  if (!order) return res.status(404).json({ error: 'order_not_found' });
  const { data: items } = await supabaseAdmin.from('merch_order_items')
    .select('*').eq('order_id', id);
  return res.status(200).json({ order, items: items || [] });
}

// POST / PATCH ─────────────────────────────────────────────────
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function upsertProduct(res, clientId, body) {
  const id = body?.id || null;
  if (id) {
    // PATCH path — whitelist updatable fields.
    const patch = {};
    if (typeof body.name === 'string')                 patch.name = body.name.trim();
    if (typeof body.description === 'string')          patch.description = body.description;
    if (Number.isFinite(+body.base_price_cents))       patch.base_price_cents = +body.base_price_cents;
    if (body.compare_at_price_cents === null)          patch.compare_at_price_cents = null;
    else if (Number.isFinite(+body.compare_at_price_cents)) patch.compare_at_price_cents = +body.compare_at_price_cents;
    if (typeof body.image_url === 'string')            patch.image_url = body.image_url || null;
    if (typeof body.printify_product_id === 'string')  patch.printify_product_id = body.printify_product_id || null;
    if (typeof body.is_active === 'boolean')           patch.is_active = body.is_active;
    if (Number.isFinite(+body.sort_order))             patch.sort_order = +body.sort_order;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabaseAdmin.from('merch_products')
      .update(patch).eq('id', id).eq('client_id', clientId).select('*').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'product_not_found' });
    return res.status(200).json({ product: data });
  }

  // INSERT path — product_key required; auto-slug from name if missing.
  const name = String(body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const productKey = String(body?.product_key || '').trim() || slugify(name);
  if (!productKey) return res.status(400).json({ error: 'product_key could not be derived' });
  const price = Number.isFinite(+body?.base_price_cents) ? +body.base_price_cents : 0;
  const row = {
    client_id:              clientId,
    product_key:            productKey,
    name,
    description:            body?.description || null,
    base_price_cents:       price,
    compare_at_price_cents: Number.isFinite(+body?.compare_at_price_cents) ? +body.compare_at_price_cents : null,
    image_url:              body?.image_url || null,
    printify_product_id:    body?.printify_product_id || null,
    is_active:              typeof body?.is_active === 'boolean' ? body.is_active : true,
    sort_order:             Number.isFinite(+body?.sort_order) ? +body.sort_order : 0
  };
  const { data, error } = await supabaseAdmin.from('merch_products')
    .insert(row).select('*').single();
  if (error) {
    if (/duplicate key/i.test(error.message)) {
      return res.status(409).json({ error: 'product_key_already_exists' });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ product: data });
}

async function deleteProduct(res, clientId, body) {
  if (!body?.id) return res.status(400).json({ error: 'id required' });
  const { error } = await supabaseAdmin.from('merch_products')
    .delete().eq('id', body.id).eq('client_id', clientId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function upsertCoupon(res, clientId, body) {
  const id = body?.id || null;
  if (id) {
    const patch = {};
    if (typeof body.name === 'string')            patch.name = body.name.trim() || null;
    if (typeof body.discount_type === 'string') {
      if (!VALID_DISCOUNT_TYPES.includes(body.discount_type)) {
        return res.status(400).json({ error: 'invalid_discount_type', valid: VALID_DISCOUNT_TYPES });
      }
      patch.discount_type = body.discount_type;
    }
    if (Number.isFinite(+body.discount_value) && +body.discount_value > 0) {
      patch.discount_value = +body.discount_value;
    }
    if (body.min_subtotal_cents === null) patch.min_subtotal_cents = null;
    else if (Number.isFinite(+body.min_subtotal_cents)) patch.min_subtotal_cents = +body.min_subtotal_cents;
    if (body.expires_at === null) patch.expires_at = null;
    else if (typeof body.expires_at === 'string' && body.expires_at) patch.expires_at = body.expires_at;
    if (body.max_uses === null) patch.max_uses = null;
    else if (Number.isFinite(+body.max_uses) && +body.max_uses > 0) patch.max_uses = +body.max_uses;
    if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });
    const { data, error } = await supabaseAdmin.from('merch_coupons')
      .update(patch).eq('id', id).eq('client_id', clientId).select('*').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data)  return res.status(404).json({ error: 'coupon_not_found' });
    return res.status(200).json({ coupon: data });
  }

  // INSERT path — code + discount_type + discount_value required.
  const code = String(body?.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: 'code required' });
  if (!VALID_DISCOUNT_TYPES.includes(body?.discount_type)) {
    return res.status(400).json({ error: 'discount_type must be percent or fixed' });
  }
  const value = +body?.discount_value;
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'discount_value must be > 0' });
  }
  if (body.discount_type === 'percent' && (value < 1 || value > 100)) {
    return res.status(400).json({ error: 'percent discounts must be 1-100' });
  }
  const row = {
    client_id:           clientId,
    code,
    name:                body?.name?.trim() || null,
    discount_type:       body.discount_type,
    discount_value:      value,
    min_subtotal_cents:  Number.isFinite(+body?.min_subtotal_cents) ? +body.min_subtotal_cents : null,
    expires_at:          body?.expires_at || null,
    max_uses:            Number.isFinite(+body?.max_uses) ? +body.max_uses : null,
    is_active:           typeof body?.is_active === 'boolean' ? body.is_active : true
  };
  const { data, error } = await supabaseAdmin.from('merch_coupons').insert(row).select('*').single();
  if (error) {
    if (/duplicate key/i.test(error.message)) {
      return res.status(409).json({ error: 'code_already_exists' });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ coupon: data });
}

async function deleteCoupon(res, clientId, body) {
  if (!body?.id) return res.status(400).json({ error: 'id required' });
  const { error } = await supabaseAdmin.from('merch_coupons')
    .delete().eq('id', body.id).eq('client_id', clientId);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

async function refundOrder(res, clientId, body) {
  if (!body?.id) return res.status(400).json({ error: 'id required' });
  const { data, error } = await supabaseAdmin.from('merch_orders')
    .update({ status: 'refunded' }).eq('id', body.id).eq('client_id', clientId)
    .select('*').maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'order_not_found' });
  return res.status(200).json({ order: data });
}

// Upload a product image to Supabase Storage and return its public
// URL. Accepts the file as a base64 data URI in the body — that way
// the frontend doesn't need to assemble multipart/form-data and the
// Vercel function doesn't need an extra parser. Roughly fine for
// reasonably-sized product photos (a few MB). Larger files should
// be uploaded direct-to-Storage; out of scope for now.
//
// Body:
//   { data_url: 'data:image/jpeg;base64,…', filename?: 'tee.jpg' }
// Response:
//   { url: 'https://<project>.supabase.co/storage/v1/object/public/merch-images/<path>' }
async function uploadImage(res, clientId, body) {
  const dataUrl = String(body?.data_url || '');
  if (!dataUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'data_url must be a base64 data URI' });
  }
  const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid_data_url' });
  const mime = m[1];
  const b64  = m[2];
  if (!/^image\//i.test(mime)) {
    return res.status(400).json({ error: 'only_image_uploads_allowed' });
  }
  // 10 MB ceiling on the decoded bytes — protects the function from
  // a runaway upload tying up memory.
  const sizeBytes = Math.floor(b64.length * 0.75);
  if (sizeBytes > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'image_too_large', max_bytes: 10 * 1024 * 1024 });
  }
  const buf = Buffer.from(b64, 'base64');

  // Extension from mime: image/jpeg → .jpg, image/png → .png, etc.
  const extFromMime = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif',  'image/webp': 'webp', 'image/heic': 'heic'
  }[mime.toLowerCase()] || 'jpg';
  const safeName = String(body?.filename || '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  const baseName = safeName ? safeName.replace(/\.[^.]+$/, '') : 'photo';
  const path = `${clientId}/${Date.now()}-${baseName}.${extFromMime}`;

  let upErr;
  {
    const r = await supabaseAdmin.storage
      .from('merch-images')
      .upload(path, buf, { contentType: mime, upsert: false });
    upErr = r.error;
  }
  // If the bucket doesn't exist, the migration row may not have
  // landed (storage.buckets writes from the SQL editor can fail
  // silently on some plans). Auto-create + retry once so the
  // operator doesn't have to debug the migration runner.
  if (upErr && /Bucket not found/i.test(upErr.message || '')) {
    const created = await supabaseAdmin.storage.createBucket('merch-images', { public: true });
    if (created.error && !/already exists/i.test(created.error.message || '')) {
      return res.status(500).json({
        error: 'could_not_create_merch_images_bucket: ' + created.error.message
      });
    }
    const retry = await supabaseAdmin.storage
      .from('merch-images')
      .upload(path, buf, { contentType: mime, upsert: false });
    upErr = retry.error;
  }
  if (upErr) return res.status(500).json({ error: 'upload_failed: ' + upErr.message });

  const { data: pub } = supabaseAdmin.storage
    .from('merch-images').getPublicUrl(path);
  return res.status(200).json({ url: pub?.publicUrl, path });
}
