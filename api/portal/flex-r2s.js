// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// GA4 analytics scoped to The Flex Facility /r2s page.
// GET /api/portal/flex-r2s
//
// Access gating: only accessible when the authed context resolves to
// The Flex Facility client (slug='flex-facility') OR the requester is
// the platform admin ab@goelev8.ai. All other tenants get 403.
//
// Uses the GA4 Data API with a pagePath dimension filter so every
// metric returned is scoped to "/r2s" only.

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const FLEX_MEASUREMENT_ID = 'G-6T75SN79LV'; // Flex Facility GA4 stream — for display only

let cachedToken = null;
let cachedTokenExpires = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpires - 60_000) return cachedToken;
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON || process.env.VITE_GA_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('GA4 service account not configured');
  const creds = JSON.parse(raw);
  if (!creds.client_email || !creds.private_key) {
    throw new Error('GA4 service account JSON missing client_email or private_key');
  }
  const { JWT } = await import('google-auth-library');
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly']
  });
  const token = await jwt.authorize();
  cachedToken = token.access_token;
  cachedTokenExpires = token.expiry_date || (Date.now() + 50 * 60 * 1000);
  return cachedToken;
}

async function runReport(propertyId, body) {
  const token = await getAccessToken();
  const url = `${GA4_BASE}/properties/${propertyId}:runReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GA4 API ${res.status}: ${await res.text()}`);
  return res.json();
}

// GA4's standard Data API has a 24–48 hour processing delay. The
// runRealtimeReport endpoint is near-instant (≤5 minute lag) but
// only covers the last 30 minutes of activity. We hit both: the
// historical report for the 30-day total, the realtime one for
// "right now" so a fresh visit shows up immediately.
async function runRealtimeReport(propertyId, body) {
  const token = await getAccessToken();
  const url = `${GA4_BASE}/properties/${propertyId}:runRealtimeReport`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GA4 Realtime API ${res.status}: ${await res.text()}`);
  return res.json();
}

// pagePath filter matching ONLY /r2s and /r2s/ exactly. The previous
// version included a BEGINS_WITH '/r2s' rule, which also caught
// /r2s-thanks, /r2s-checkout, /r2s-promo etc. — inflating the page-view
// count by counting downstream funnel pages as if they were /r2s itself.
const PATH_FILTER = {
  orGroup: {
    expressions: [
      { filter: { fieldName: 'pagePath', stringFilter: { value: '/r2s',  matchType: 'EXACT' } } },
      { filter: { fieldName: 'pagePath', stringFilter: { value: '/r2s/', matchType: 'EXACT' } } }
    ]
  }
};

// Tenants that sell the R2S ebook. Add slugs here when new affiliates
// pick up the same product line — each tenant uses their OWN GA4
// property + their own /r2s page traffic.
const R2S_TENANT_SLUGS = ['flex-facility', 'willpower-fitness'];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  // Access gating: a tenant in the R2S list (impersonated or signed in
  // directly) OR the platform admin even when not impersonating.
  const isPlatformAdmin = ctx.user?.email === 'ab@goelev8.ai';
  let propertyId = null;
  let clientSlug = null;
  let parentClientId = null;
  if (ctx.clientId) {
    const { data: client } = await supabaseAdmin
      .from('clients').select('slug, ga4_property_id, parent_client_id').eq('id', ctx.clientId).maybeSingle();
    clientSlug = client?.slug || null;
    propertyId = client?.ga4_property_id || null;
    parentClientId = client?.parent_client_id || null;
  }
  const isR2sTenant = R2S_TENANT_SLUGS.includes(clientSlug);
  if (!isPlatformAdmin && !isR2sTenant) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Reseller model: child tenants (e.g. Will Power Fitness Factory)
  // sell the R2S ebook through their parent's storefront, so the /r2s
  // page they care about lives on the parent's domain — query the
  // parent's GA4 property regardless of the child's own property.
  // This keeps Will's R2S panel mirroring exactly what Flex sees.
  if (parentClientId) {
    const { data: parent } = await supabaseAdmin
      .from('clients').select('ga4_property_id').eq('id', parentClientId).maybeSingle();
    if (parent?.ga4_property_id) propertyId = parent.ga4_property_id;
  }

  // If the admin hits this endpoint without impersonating any tenant,
  // we don't know which GA4 property to query. Fall back to Flex's so
  // the platform-admin-direct path keeps working.
  if (!propertyId) {
    const fallbackSlug = isR2sTenant ? clientSlug : 'flex-facility';
    const { data: fallbackRow } = await supabaseAdmin
      .from('clients').select('ga4_property_id').eq('slug', fallbackSlug).maybeSingle();
    propertyId = fallbackRow?.ga4_property_id || process.env.GA4_PROPERTY_ID;
  }

  if (!propertyId) {
    return res.status(200).json({
      configured: false,
      message: 'Flex Facility GA4 property ID not set. Update clients.ga4_property_id (slug=flex-facility) in Supabase.',
      measurement_id: FLEX_MEASUREMENT_ID
    });
  }

  try {
    const [overview, sources, events, byDay, realtime] = await Promise.all([
      // 1. Overview metrics for /r2s
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'totalUsers' },
          { name: 'userEngagementDuration' },
          { name: 'sessions' },
          { name: 'bounceRate' }
        ],
        dimensionFilter: PATH_FILTER
      }),
      // 2. Top traffic sources to /r2s
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        dimensionFilter: PATH_FILTER,
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10
      }),
      // 3. Conversion events fired on /r2s
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          andGroup: {
            expressions: [
              PATH_FILTER,
              {
                filter: {
                  fieldName: 'eventName',
                  inListFilter: {
                    values: ['lead_captured', 'booking_initiated', 'purchase', 'begin_checkout', 'generate_lead', 'sign_up']
                  }
                }
              }
            ]
          }
        }
      }),
      // 4. Views per day for the sparkline / chart
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
        dimensionFilter: PATH_FILTER,
        orderBys: [{ dimension: { dimensionName: 'date' } }]
      }),
      // 5. Realtime — last 30 minutes. Bypasses the 24-48h processing
      // delay so a fresh visit shows up in seconds. Soft-fails so a
      // realtime API hiccup never breaks the historical report.
      runRealtimeReport(propertyId, {
        metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }],
        dimensionFilter: PATH_FILTER
      }).catch(() => null)
    ]);

    const ov = overview.rows?.[0]?.metricValues || [];
    const page_views = parseInt(ov[0]?.value || '0', 10);
    const users = parseInt(ov[1]?.value || '0', 10);
    const engagement_seconds = parseFloat(ov[2]?.value || '0');
    const sessions = parseInt(ov[3]?.value || '0', 10);
    const bounce_rate = parseFloat(ov[4]?.value || '0');
    const avg_time_on_page = users > 0 ? engagement_seconds / users : 0;

    const top_sources = (sources.rows || []).map(r => ({
      source: r.dimensionValues[0].value || '(direct)',
      sessions: parseInt(r.metricValues[0].value, 10),
      users: parseInt(r.metricValues[1].value, 10)
    }));

    const conversions = {};
    for (const row of (events.rows || [])) {
      conversions[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value, 10);
    }

    const by_day = {};
    for (const row of (byDay.rows || [])) {
      const raw = row.dimensionValues[0].value; // YYYYMMDD
      const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      by_day[date] = {
        views: parseInt(row.metricValues[0].value, 10),
        users: parseInt(row.metricValues[1].value, 10)
      };
    }

    // Parse the realtime response: a single row whose metric values are
    // the active users + page views in the last 30 minutes.
    const rtRow = realtime?.rows?.[0]?.metricValues || [];
    const realtime_active_users  = parseInt(rtRow[0]?.value || '0', 10);
    const realtime_page_views_30m = parseInt(rtRow[1]?.value || '0', 10);

    return res.status(200).json({
      configured: true,
      property_id: propertyId,
      measurement_id: FLEX_MEASUREMENT_ID,
      page_path: '/r2s',
      page_views,
      users,
      sessions,
      avg_time_on_page,
      bounce_rate,
      top_sources,
      conversions,
      by_day,
      // Near-real-time (≤5 minute lag) — surfaces visits the historical
      // 30-day report won't show until tomorrow.
      realtime: {
        active_users: realtime_active_users,
        page_views_last_30_min: realtime_page_views_30m,
        as_of: new Date().toISOString()
      },
      // Operator-visible note about the historical 30-day numbers.
      historical_note: 'Standard GA4 reports update once per day (24–48h delay). Realtime numbers above show the last 30 minutes.'
    });
  } catch (e) {
    return res.status(200).json({
      configured: true,
      error: e.message,
      measurement_id: FLEX_MEASUREMENT_ID
    });
  }
}
