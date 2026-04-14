// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Road To The Stage ebook sales — filtered view of the sales table
// for The Flex Facility, matching product name or metadata "road to
// the stage" / "r2s".
//
// Access gated: only ab@goelev8.ai OR a user whose client.slug is
// 'flex-facility' can reach this endpoint. Other tenants get 403.
//
// GET  /api/portal/r2s-sales        → stats + sales list + daily chart
// POST /api/portal/r2s-sales        → manually record a sale
//       body: { customer_name, customer_email, amount_cents, note }

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const R2S_MATCHERS = ['road to the stage', 'r2s', 'road-to-the-stage'];

function isR2sSale(sale) {
  const hay = [
    sale.products?.name,
    sale.source,
    sale.stripe_session_id
  ].filter(Boolean).join(' ').toLowerCase();
  return R2S_MATCHERS.some(m => hay.includes(m));
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  // Gate to Flex Facility client or platform admin
  const isPlatformAdmin = ctx.user?.email === 'ab@goelev8.ai';
  let flexClientId = null;
  if (ctx.clientId) {
    const { data: c } = await supabaseAdmin
      .from('clients').select('id, slug, stripe_secret_key, stripe_connected_account_id')
      .eq('id', ctx.clientId).maybeSingle();
    if (c?.slug === 'flex-facility') flexClientId = c.id;
  }
  if (!flexClientId && isPlatformAdmin) {
    const { data: flex } = await supabaseAdmin
      .from('clients').select('id').eq('slug', 'flex-facility').maybeSingle();
    flexClientId = flex?.id || null;
  }
  if (!flexClientId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Check if Stripe is connected for this client
  const { data: flex } = await supabaseAdmin
    .from('clients')
    .select('stripe_secret_key, stripe_connected_account_id')
    .eq('id', flexClientId).maybeSingle();
  const stripeConnected = !!(flex?.stripe_secret_key || flex?.stripe_connected_account_id);

  // ---------- POST: manual sale entry ----------
  if (req.method === 'POST') {
    const body = await readJson(req);
    const { customer_name, customer_email, amount_cents, note } = body || {};
    const amt = parseInt(amount_cents, 10);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }
    const { data, error } = await supabaseAdmin.from('sales').insert({
      client_id: flexClientId,
      amount: amt / 100,
      currency: 'usd',
      customer_name: customer_name || null,
      customer_email: customer_email || null,
      payment_status: 'paid',
      source: note ? `r2s_manual:${String(note).slice(0, 80)}` : 'r2s_manual',
      stripe_session_id: `manual_r2s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ sale: data });
  }

  // ---------- GET: stats + list ----------
  const { data: allSales, error } = await supabaseAdmin
    .from('sales')
    .select('*, products(name)')
    .eq('client_id', flexClientId)
    .eq('payment_status', 'paid')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) return res.status(500).json({ error: error.message });

  const sales = (allSales || []).filter(isR2sSale);

  const totalUnits = sales.length;
  const totalRevenueCents = sales.reduce((s, x) => s + Math.round((Number(x.amount) || 0) * 100), 0);

  // Daily chart — last 30 days
  const now = new Date();
  const by_day = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    by_day[d.toISOString().split('T')[0]] = { units: 0, revenue_cents: 0 };
  }
  for (const s of sales) {
    const k = new Date(s.created_at).toISOString().split('T')[0];
    if (by_day[k] !== undefined) {
      by_day[k].units += 1;
      by_day[k].revenue_cents += Math.round((Number(s.amount) || 0) * 100);
    }
  }

  return res.status(200).json({
    stripe_connected: stripeConnected,
    total_units: totalUnits,
    total_revenue_cents: totalRevenueCents,
    by_day,
    sales: sales.slice(0, 25).map(s => ({
      id: s.id,
      created_at: s.created_at,
      customer_name: s.customer_name,
      customer_email: s.customer_email,
      amount_cents: Math.round((Number(s.amount) || 0) * 100),
      source: s.source,
      product_name: s.products?.name || null
    }))
  });
}
