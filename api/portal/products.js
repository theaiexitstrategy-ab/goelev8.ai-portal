// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Products CRUD — GET list, POST create, PATCH update, DELETE remove

import { requireUser, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { clientId } = ctx;

  // GET — list products with sale stats
  if (req.method === 'GET') {
    const { data: products, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('client_id', clientId)
      .order('display_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // Attach sale counts and revenue per product
    const { data: salesAgg } = await supabaseAdmin
      .from('sales')
      .select('product_id, amount, payment_status')
      .eq('client_id', clientId)
      .eq('payment_status', 'paid');

    const statsMap = {};
    for (const s of (salesAgg || [])) {
      if (!s.product_id) continue;
      if (!statsMap[s.product_id]) statsMap[s.product_id] = { count: 0, revenue: 0 };
      statsMap[s.product_id].count++;
      statsMap[s.product_id].revenue += Number(s.amount) || 0;
    }

    const enriched = (products || []).map(p => ({
      ...p,
      sales_count: statsMap[p.id]?.count || 0,
      total_revenue: statsMap[p.id]?.revenue || 0
    }));

    return res.json({ products: enriched });
  }

  // POST — create product
  if (req.method === 'POST') {
    const body = await readJson(req);
    const { name, description, price, currency, stripe_price_id, stripe_payment_link,
            image_url, is_active, show_in_funnel, funnel_pages, display_order } = body;

    if (!name) return res.status(400).json({ error: 'name_required' });

    const { data, error } = await supabaseAdmin.from('products').insert({
      client_id: clientId,
      name,
      description: description || null,
      price: price || 0,
      currency: currency || 'usd',
      stripe_price_id: stripe_price_id || null,
      stripe_payment_link: stripe_payment_link || null,
      image_url: image_url || null,
      is_active: is_active !== false,
      show_in_funnel: !!show_in_funnel,
      funnel_pages: funnel_pages || [],
      display_order: display_order || 0
    }).select('*').single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ product: data });
  }

  // PATCH — update product
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...updates } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });

    // Only allow updating own products
    const { data, error } = await supabaseAdmin
      .from('products')
      .update(updates)
      .eq('id', id)
      .eq('client_id', clientId)
      .select('*')
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ product: data });
  }

  // DELETE — remove product
  if (req.method === 'DELETE') {
    const body = await readJson(req);
    if (!body.id) return res.status(400).json({ error: 'id_required' });

    const { error } = await supabaseAdmin
      .from('products')
      .delete()
      .eq('id', body.id)
      .eq('client_id', clientId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ deleted: true });
  }

  res.status(405).json({ error: 'method_not_allowed' });
}
