// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Analytics API — aggregated metrics from Supabase tables (leads, bookings, sales)

import { requireUser } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { dedupeLeadRows } from '../../lib/lead-dedupe.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { clientId } = ctx;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Fetch all data in parallel. `artist_selected` is an iSlay-portal
  // column (migration 0010) used for the byArtist breakdown.
  // Helper: tolerant fetch that strips deleted_at filter on pre-0024
  // schemas so analytics keeps working before the migration runs.
  const fetchLeads30 = async () => {
    let q = supabaseAdmin.from('leads')
      .select('id, name, phone, email, created_at, source, status, artist_selected, tags, paid_at')
      .eq('client_id', clientId)
      .is('deleted_at', null)
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false });
    let { data, error } = await q;
    if (error && /column .*\b(deleted_at|paid_at|tags)\b.* does not exist/i.test(error.message)) {
      const retry = await supabaseAdmin.from('leads')
        .select('id, name, phone, email, created_at, source, status, artist_selected')
        .eq('client_id', clientId)
        .gte('created_at', thirtyDaysAgo.toISOString())
        .order('created_at', { ascending: false });
      data = retry.data; error = retry.error;
    }
    return { data: data || [], error };
  };

  const [leadsR, bookingsR, salesR, callsR, messagesR, ledgerR] = await Promise.all([
    fetchLeads30(),
    supabaseAdmin.from('bookings').select('id, created_at, starts_at, status')
      .eq('client_id', clientId).gte('created_at', thirtyDaysAgo.toISOString()),
    supabaseAdmin.from('sales').select('id, amount, created_at, payment_status')
      .eq('client_id', clientId).eq('payment_status', 'paid')
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabaseAdmin.from('vapi_calls').select('id, created_at')
      .eq('client_id', clientId).gte('created_at', thirtyDaysAgo.toISOString()),
    supabaseAdmin.from('messages').select('id, status, direction, created_at')
      .eq('client_id', clientId).eq('direction', 'outbound')
      .gte('created_at', thirtyDaysAgo.toISOString()),
    supabaseAdmin.from('credit_ledger').select('delta, created_at')
      .eq('client_id', clientId).gte('created_at', thirtyDaysAgo.toISOString())
      .lt('delta', 0)
  ]);

  // Dedupe with the same family-share guard the leads list endpoint
  // uses, so /api/portal/analytics and /api/portal/crm?action=leads
  // never disagree on Leads Captured.
  const leads = dedupeLeadRows(leadsR.data || []);
  const bookings = bookingsR.data || [];
  const sales = salesR.data || [];
  const calls = callsR.data || [];
  const messages = messagesR.data || [];
  const ledger = ledgerR.data || [];

  // Total leads and month comparison
  const leadsThisMonth = leads.filter(l => new Date(l.created_at) >= monthStart);
  const leadsLastMonth = leads.filter(l => {
    const d = new Date(l.created_at);
    return d >= lastMonthStart && d < monthStart;
  });

  // For last month leads, fetch separately and run through the same
  // dedupe + soft-delete filter so the % change isn't skewed by dupes.
  const fetchLastMonthLeads = async () => {
    let q = supabaseAdmin.from('leads')
      .select('id, name, phone, email, created_at, tags, paid_at')
      .eq('client_id', clientId)
      .is('deleted_at', null)
      .gte('created_at', lastMonthStart.toISOString())
      .lt('created_at', monthStart.toISOString());
    let { data, error } = await q;
    if (error && /column .*\b(deleted_at|paid_at|tags)\b.* does not exist/i.test(error.message)) {
      const retry = await supabaseAdmin.from('leads')
        .select('id, name, phone, email, created_at')
        .eq('client_id', clientId)
        .gte('created_at', lastMonthStart.toISOString())
        .lt('created_at', monthStart.toISOString());
      data = retry.data;
    }
    return data || [];
  };
  const lastMonthLeads = dedupeLeadRows(await fetchLastMonthLeads());

  const leadsThisMonthCount = leadsThisMonth.length;
  const leadsLastMonthCount = lastMonthLeads.length;
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

  // SMS counts (last 30 days, outbound only — inbound doesn't burn credits).
  // Treat anything not failed/undelivered as a successful send so partial
  // status fields ('queued', 'sent', 'delivered') all roll up.
  let smsSent = 0, smsFailed = 0;
  for (const m of messages) {
    const s = (m.status || '').toLowerCase();
    if (s === 'failed' || s === 'undelivered') smsFailed++;
    else smsSent++;
  }

  // Credits spent in the last 30 days. Ledger deltas are negative for
  // spend, positive for grants/refunds — we already filtered to negative.
  const creditsSpent = ledger.reduce((sum, r) => sum + Math.abs(Number(r.delta) || 0), 0);

  // Leads grouped by artist_selected (iSlay-specific). Skip rows with no
  // artist set so the bar chart isn't dominated by "Unknown".
  const byArtistMap = {};
  for (const l of leads) {
    const a = (l.artist_selected || '').trim();
    if (!a) continue;
    byArtistMap[a] = (byArtistMap[a] || 0) + 1;
  }
  const byArtist = Object.entries(byArtistMap)
    .sort((a, b) => b[1] - a[1])
    .map(([artist, count]) => ({ artist, count }));

  // Daily leads as an ordered array — branded page expects this shape.
  const leadsOverTime = Object.entries(leadsByDay)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  // Top sources reshaped to {source, count} for the branded bar chart.
  const bySource = topSources.map(s => ({ source: s.source, count: s.count }));

  // Tenant Activity uses ROLLING 30-day windows — the queries above
  // already filter `created_at >= thirtyDaysAgo`, so .length on each
  // collection is the right "last 30 days" count. The previous numbers
  // were keyed off monthStart, so on the 5th of the month they reset
  // to ~5 days of data and looked alarmingly low.
  const leads30d    = leads.length;        // already deduped + soft-delete filtered
  const bookings30d = bookings.length;
  const sms30d      = messages.length;     // outbound only (filtered above)
  const calls30d    = calls.length;
  // Keep the "this month" numbers too so legacy callers still work.
  const smsThisMonth = messages.filter(m =>
    new Date(m.created_at) >= monthStart).length;
  const callsThisMonth = calls.filter(c =>
    new Date(c.created_at) >= monthStart).length;

  return res.json({
    // Existing nested shape — kept for backward compatibility.
    overview: {
      total_leads: leadsThisMonthCount,
      leads_change: parseFloat(leadsChange),
      bookings_this_month: bookingsThisMonth,
      revenue_this_month: revenueThisMonth,
      sms_sent: smsThisMonth,
      calls_this_month: callsThisMonth,
      // Rolling 30-day counts the new Tenant Activity panel uses.
      leads_30d: leads30d,
      bookings_30d: bookings30d,
      sms_30d: sms30d,
      calls_30d: calls30d
    },
    leads_by_day: leadsByDay,
    sales_by_day: salesByDay,
    leads_by_source: leadsBySource,
    funnel_leads: funnelLeads,
    top_sources: topSources,
    recent_activity: activity,
    // Flat keys consumed by clients/islaystudios/analytics.html.
    leadsThisMonth: leadsThisMonthCount,
    leadsLastMonth: leadsLastMonthCount,
    smsSent,
    smsFailed,
    creditsSpent,
    bySource,
    byArtist,
    leadsOverTime
  });
}
