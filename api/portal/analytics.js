// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Analytics API — aggregated metrics from Supabase tables (leads, bookings, sales)

import { requireUser } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { clientId } = ctx;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Fetch all data in parallel
  const [leadsR, bookingsR, salesR, callsR] = await Promise.all([
    supabaseAdmin.from('leads').select('id, created_at, source, status')
      .eq('client_id', clientId).gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false }),
    supabaseAdmin.from('bookings').select('id, created_at, starts_at, status')
      .eq('client_id', clientId).gte('created_at', thirtyDaysAgo.toISOString()),
    supabaseAdmin.from('sales').select('id, amount, created_at, payment_status')
      .eq('client_id', clientId).eq('payment_status', 'paid')
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabaseAdmin.from('vapi_calls').select('id, created_at')
      .eq('client_id', clientId).gte('created_at', thirtyDaysAgo.toISOString())
  ]);

  const leads = leadsR.data || [];
  const bookings = bookingsR.data || [];
  const sales = salesR.data || [];
  const calls = callsR.data || [];

  // Total leads and month comparison
  const leadsThisMonth = leads.filter(l => new Date(l.created_at) >= monthStart);
  const leadsLastMonth = leads.filter(l => {
    const d = new Date(l.created_at);
    return d >= lastMonthStart && d < monthStart;
  });

  // For last month leads, we also need to fetch separately since our window is only 30 days
  const { data: lastMonthLeads } = await supabaseAdmin
    .from('leads').select('id')
    .eq('client_id', clientId)
    .gte('created_at', lastMonthStart.toISOString())
    .lt('created_at', monthStart.toISOString());

  const leadsThisMonthCount = leadsThisMonth.length;
  const leadsLastMonthCount = (lastMonthLeads || []).length;
  const leadsChange = leadsLastMonthCount > 0
    ? ((leadsThisMonthCount - leadsLastMonthCount) / leadsLastMonthCount * 100).toFixed(1)
    : leadsThisMonthCount > 0 ? '100.0' : '0.0';

  // Bookings confirmed this month
  const bookingsThisMonth = bookings.filter(b =>
    new Date(b.created_at) >= monthStart &&
    ['confirmed', 'completed', 'scheduled'].includes((b.status || '').toLowerCase())
  ).length;

  // Revenue this month
  const revenueThisMonth = sales
    .filter(s => new Date(s.created_at) >= monthStart)
    .reduce((sum, s) => sum + (Number(s.amount) || 0), 0);

  // Leads by day (last 30 days)
  const leadsByDay = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    leadsByDay[key] = 0;
  }
  for (const l of leads) {
    const key = new Date(l.created_at).toISOString().split('T')[0];
    if (leadsByDay[key] !== undefined) leadsByDay[key]++;
  }

  // Sales by day (last 30 days)
  const salesByDay = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    salesByDay[key] = 0;
  }
  for (const s of sales) {
    const key = new Date(s.created_at).toISOString().split('T')[0];
    if (salesByDay[key] !== undefined) salesByDay[key] += Number(s.amount) || 0;
  }

  // Leads by source
  const leadsBySource = {};
  for (const l of leads) {
    const src = l.source || 'Unknown';
    leadsBySource[src] = (leadsBySource[src] || 0) + 1;
  }

  // Funnel conversion data (leads by source for specific funnels)
  const { data: allLeads } = await supabaseAdmin
    .from('leads').select('source')
    .eq('client_id', clientId);

  const funnelLeads = {};
  for (const l of (allLeads || [])) {
    const src = l.source || '';
    funnelLeads[src] = (funnelLeads[src] || 0) + 1;
  }

  // Top sources ranked
  const topSources = Object.entries(leadsBySource)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([source, count]) => ({ source, count }));

  // Recent activity (last 20 events combined)
  const { data: recentLeads } = await supabaseAdmin
    .from('leads').select('id, name, source, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false }).limit(20);
  const { data: recentBookings } = await supabaseAdmin
    .from('bookings').select('id, service, status, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false }).limit(20);
  const { data: recentSales } = await supabaseAdmin
    .from('sales').select('id, customer_name, amount, created_at')
    .eq('client_id', clientId).eq('payment_status', 'paid')
    .order('created_at', { ascending: false }).limit(20);
  const { data: recentCalls } = await supabaseAdmin
    .from('vapi_calls').select('id, caller_phone, outcome, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false }).limit(20);

  const activity = [
    ...(recentLeads || []).map(l => ({ type: 'lead', name: l.name, action: 'submitted a lead', source: l.source, ts: l.created_at })),
    ...(recentBookings || []).map(b => ({ type: 'booking', name: b.service, action: 'booked', source: b.status, ts: b.created_at })),
    ...(recentSales || []).map(s => ({ type: 'sale', name: s.customer_name, action: `purchased ($${Number(s.amount).toFixed(2)})`, source: 'sale', ts: s.created_at })),
    ...(recentCalls || []).map(c => ({ type: 'call', name: c.caller_phone, action: `called (${c.outcome || 'received'})`, source: 'Vapi', ts: c.created_at }))
  ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 20);

  return res.json({
    overview: {
      total_leads: leadsThisMonthCount,
      leads_change: parseFloat(leadsChange),
      bookings_this_month: bookingsThisMonth,
      revenue_this_month: revenueThisMonth,
    },
    leads_by_day: leadsByDay,
    sales_by_day: salesByDay,
    leads_by_source: leadsBySource,
    funnel_leads: funnelLeads,
    top_sources: topSources,
    recent_activity: activity
  });
}
