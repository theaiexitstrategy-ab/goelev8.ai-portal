// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Sales API — GET overview stats + paginated list

import { requireUser } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { clientId } = ctx;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || 'list';

  // GET ?action=stats — overview cards
  if (action === 'stats') {
    const { data: allSales } = await supabaseAdmin
      .from('sales')
      .select('amount, payment_status, created_at')
      .eq('client_id', clientId);

    const paid = (allSales || []).filter(s => s.payment_status === 'paid');
    const totalRevenue = paid.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const totalCount = paid.length;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const thisMonth = paid.filter(s => new Date(s.created_at) >= monthStart);
    const lastMonth = paid.filter(s => {
      const d = new Date(s.created_at);
      return d >= lastMonthStart && d < monthStart;
    });
    const today = paid.filter(s => new Date(s.created_at) >= todayStart);

    const thisMonthRev = thisMonth.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const lastMonthRev = lastMonth.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
    const todayRev = today.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

    const monthChange = lastMonthRev > 0
      ? ((thisMonthRev - lastMonthRev) / lastMonthRev * 100).toFixed(1)
      : thisMonthRev > 0 ? '100.0' : '0.0';

    return res.json({
      total_revenue: totalRevenue,
      total_count: totalCount,
      this_month_revenue: thisMonthRev,
      this_month_count: thisMonth.length,
      last_month_revenue: lastMonthRev,
      month_change: parseFloat(monthChange),
      today_revenue: todayRev,
      today_count: today.length,
      last_updated: now.toISOString()
    });
  }

  // GET ?action=list — paginated sales
  const page = parseInt(url.searchParams.get('page') || '1', 10);
  const limit = 20;
  const offset = (page - 1) * limit;
  const product = url.searchParams.get('product');
  const status = url.searchParams.get('status');
  const period = url.searchParams.get('period');
  const search = url.searchParams.get('search');

  let query = supabaseAdmin
    .from('sales')
    .select('*, products(name, image_url)', { count: 'exact' })
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (product && product !== 'all') {
    query = query.eq('product_id', product);
  }
  if (status && status !== 'all') {
    query = query.eq('payment_status', status);
  }
  if (period === 'today') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    query = query.gte('created_at', todayStart.toISOString());
  } else if (period === 'this_month') {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    query = query.gte('created_at', monthStart.toISOString());
  } else if (period === 'last_month') {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    query = query.gte('created_at', lastMonthStart.toISOString()).lt('created_at', monthStart.toISOString());
  }
  if (search) {
    query = query.or(`customer_name.ilike.%${search}%,customer_email.ilike.%${search}%`);
  }

  const { data: sales, count, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  return res.json({
    sales: sales || [],
    total: count || 0,
    page,
    pages: Math.ceil((count || 0) / limit)
  });
}
