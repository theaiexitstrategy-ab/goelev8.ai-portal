// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Funnel view stats endpoint — returns view counts, source breakdown,
// and 30-day time series for analytics dashboard.
// GET /api/portal/funnel-views

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Total views this month
  const { count: monthCount } = await supabaseAdmin
    .from('funnel_views')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('viewed_at', startOfMonth.toISOString());

  // All view rows in last 30 days for source + day breakdown. Pulls
  // `path` too so we can break out per-page traffic (e.g. /merch).
  // Tolerant retry without `path` for projects mid-migration.
  let { data: rows, error } = await supabaseAdmin
    .from('funnel_views')
    .select('slug, path, referrer, viewed_at')
    .eq('client_id', clientId)
    .gte('viewed_at', thirtyDaysAgo.toISOString())
    .order('viewed_at', { ascending: false })
    .limit(5000);
  if (error && /column .*path.* does not exist/i.test(error.message || '')) {
    const retry = await supabaseAdmin
      .from('funnel_views')
      .select('slug, referrer, viewed_at')
      .eq('client_id', clientId)
      .gte('viewed_at', thirtyDaysAgo.toISOString())
      .order('viewed_at', { ascending: false })
      .limit(5000);
    rows = retry.data; error = retry.error;
  }

  if (error) {
    return res.status(200).json({ count: 0, by_source: [], by_day: {}, by_slug: [], by_path: [], storefront: null });
  }

  const data = rows || [];

  // Group by referrer source (extract domain)
  const sourceMap = {};
  for (const r of data) {
    let src = r.referrer || 'Direct';
    try {
      if (src && src !== 'Direct') {
        const u = new URL(src);
        src = u.hostname.replace(/^www\./, '');
      }
    } catch {}
    sourceMap[src] = (sourceMap[src] || 0) + 1;
  }
  const by_source = Object.entries(sourceMap)
    .sort((a, b) => b[1] - a[1])
    .map(([source, count]) => ({ source, count }));

  // Group by funnel slug (legacy field — pre-path-column)
  const slugMap = {};
  for (const r of data) {
    const s = r.slug || '/';
    slugMap[s] = (slugMap[s] || 0) + 1;
  }
  const by_slug = Object.entries(slugMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([slug, count]) => ({ slug, count }));

  // Group by page path — the more useful breakdown now that
  // embed/track.js sends location.pathname. Top 20 so the analytics
  // tab can list every meaningful page.
  const pathMap = {};
  for (const r of data) {
    if (!r.path) continue;
    pathMap[r.path] = (pathMap[r.path] || 0) + 1;
  }
  const by_path = Object.entries(pathMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, count }));

  // Time series — views per day for last 30 days
  const by_day = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    by_day[d.toISOString().split('T')[0]] = 0;
  }
  for (const r of data) {
    const key = new Date(r.viewed_at).toISOString().split('T')[0];
    if (by_day[key] !== undefined) by_day[key]++;
  }

  // ── Storefront-specific breakout ──
  // The tenant's /merch page is the cash register; surface its own
  // traffic numbers + conversion (views → orders). Views are matched
  // by path prefix because subpaths like /merch/shampoo should roll
  // up into the storefront bucket.
  const merchViewsRecent = data.filter(r =>
    typeof r.path === 'string' && /^\/merch(\/|$)/.test(r.path)
  );
  const merchViewsByDay = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    merchViewsByDay[d.toISOString().split('T')[0]] = 0;
  }
  for (const r of merchViewsRecent) {
    const key = new Date(r.viewed_at).toISOString().split('T')[0];
    if (merchViewsByDay[key] !== undefined) merchViewsByDay[key]++;
  }

  // Pull paid merch orders in the same 30-day window for conversion.
  // Tolerant of merch_orders table not existing yet on legacy projects.
  let merchOrders30d = 0;
  try {
    const { count } = await supabaseAdmin
      .from('merch_orders')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .in('status', ['paid', 'fulfilled', 'shipped'])
      .gte('created_at', thirtyDaysAgo.toISOString());
    merchOrders30d = count || 0;
  } catch { /* table missing → 0 orders */ }

  const merchViews30d = merchViewsRecent.length;
  const conversionPct = merchViews30d > 0
    ? Math.round((merchOrders30d / merchViews30d) * 1000) / 10
    : null;

  return res.status(200).json({
    count: monthCount || 0,
    total_30d: data.length,
    by_source,
    by_slug,
    by_path,
    by_day,
    storefront: {
      path:           '/merch',
      views_30d:      merchViews30d,
      orders_30d:     merchOrders30d,
      conversion_pct: conversionPct,
      by_day:         merchViewsByDay
    }
  });
}
