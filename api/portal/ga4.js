// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Google Analytics GA4 Data API endpoint.
//
// Pulls live metrics from a GA4 property and returns them in a normalized
// shape the portal Analytics tab can render.
//
// Required env vars (set in Vercel):
//   GA4_PROPERTY_ID         — numeric GA4 property ID (e.g. "123456789")
//   GA4_SERVICE_ACCOUNT_JSON — full service account JSON as a single line
//
// Setup:
//   1. Google Cloud Console → enable "Google Analytics Data API"
//   2. Create a service account, download key as JSON
//   3. In GA4 Admin → Property Access Management, add the service account
//      email as a Viewer
//   4. Set GA4_PROPERTY_ID to the numeric property ID (Admin → Property Settings)
//   5. Paste the entire service account JSON into GA4_SERVICE_ACCOUNT_JSON

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta';

let cachedToken = null;
let cachedTokenExpires = 0;

async function getAccessToken() {
  // Reuse token while still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedTokenExpires - 60_000) {
    return cachedToken;
  }
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GA4_SERVICE_ACCOUNT_JSON not set');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  // Validate required fields before handing to google-auth-library.
  // The JWT constructor throws an opaque "No key or keyFile set" if
  // private_key is falsy, which is hard to debug without this check.
  if (!creds.client_email) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is missing client_email');
  }
  if (!creds.private_key) {
    throw new Error('GA4_SERVICE_ACCOUNT_JSON is missing private_key');
  }

  // Fix double-escaped newlines — the most common env-var pasting issue.
  // When the JSON is pasted into Vercel's env var UI, the literal two-char
  // sequence \n inside the private_key PEM can get stored as \\n (the
  // backslash itself is escaped). JSON.parse turns \\n into the literal
  // string "\n" (two chars: backslash + n) instead of a real newline.
  // google-auth-library can't parse the PEM without real newlines between
  // the base64 blocks.
  if (creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  // Use google-auth-library JWT flow
  const { JWT } = await import('google-auth-library');
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/analytics.readonly']
  });
  const tok = await client.authorize();
  cachedToken = tok.access_token;
  cachedTokenExpires = tok.expiry_date || Date.now() + 3500_000;
  return cachedToken;
}

async function runReport(propertyId, body) {
  const token = await getAccessToken();
  const res = await fetch(`${GA4_BASE}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GA4 API ${res.status}: ${err}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  // Resolve the GA4 property for this request:
  //   - If impersonating / client context → use client.ga4_property_id
  //   - Otherwise (admin platform view) → use env GA4_PROPERTY_ID
  let propertyId = null;
  let propertyLabel = 'Platform-wide';
  if (ctx.clientId) {
    const { data: client } = await supabaseAdmin
      .from('clients').select('name, ga4_property_id').eq('id', ctx.clientId).maybeSingle();
    propertyId = client?.ga4_property_id || null;
    propertyLabel = client?.name || 'Client';
  }
  if (!propertyId) {
    propertyId = process.env.GA4_PROPERTY_ID;
  }

  if (!propertyId || !process.env.GA4_SERVICE_ACCOUNT_JSON) {
    return res.status(200).json({
      configured: false,
      error: ctx.clientId
        ? `No GA4 property configured for ${propertyLabel}. Set clients.ga4_property_id in Supabase or GA4_PROPERTY_ID env var.`
        : 'GA4 not configured. Set GA4_PROPERTY_ID and GA4_SERVICE_ACCOUNT_JSON env vars.',
      sessions: 0,
      page_views: 0,
      users: 0,
      by_day: {},
      top_sources: [],
      top_pages: [],
      events: {}
    });
  }

  try {
    // Run multiple reports in parallel
    const [overview, byDay, sources, pages, events] = await Promise.all([
      // 1. Overview totals (last 30 days)
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        metrics: [
          { name: 'sessions' },
          { name: 'screenPageViews' },
          { name: 'totalUsers' },
          { name: 'engagedSessions' }
        ]
      }),
      // 2. Sessions by day (last 30 days)
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }]
      }),
      // 3. Top sources / referrers
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'sessionSource' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10
      }),
      // 4. Top pages
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }, { name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10
      }),
      // 5. Custom event totals
      runReport(propertyId, {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: {
            fieldName: 'eventName',
            inListFilter: {
              values: ['lead_viewed', 'booking_viewed', 'call_log_viewed', 'client_login']
            }
          }
        }
      })
    ]);

    // Parse overview
    const ovRow = overview.rows?.[0]?.metricValues || [];
    const sessions = parseInt(ovRow[0]?.value || '0', 10);
    const pageViews = parseInt(ovRow[1]?.value || '0', 10);
    const users = parseInt(ovRow[2]?.value || '0', 10);
    const engaged = parseInt(ovRow[3]?.value || '0', 10);

    // Parse by_day → { 'YYYY-MM-DD': { sessions, page_views } }
    const by_day = {};
    for (const row of (byDay.rows || [])) {
      const raw = row.dimensionValues[0].value; // YYYYMMDD
      const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      by_day[date] = {
        sessions: parseInt(row.metricValues[0].value, 10),
        page_views: parseInt(row.metricValues[1].value, 10)
      };
    }

    // Parse top sources
    const top_sources = (sources.rows || []).map(r => ({
      source: r.dimensionValues[0].value || '(direct)',
      sessions: parseInt(r.metricValues[0].value, 10),
      users: parseInt(r.metricValues[1].value, 10)
    }));

    // Parse top pages
    const top_pages = (pages.rows || []).map(r => ({
      path: r.dimensionValues[0].value,
      views: parseInt(r.metricValues[0].value, 10),
      sessions: parseInt(r.metricValues[1].value, 10)
    }));

    // Parse custom events
    const eventTotals = {};
    for (const row of (events.rows || [])) {
      eventTotals[row.dimensionValues[0].value] = parseInt(row.metricValues[0].value, 10);
    }

    return res.status(200).json({
      configured: true,
      property_id: propertyId,
      property_label: propertyLabel,
      sessions,
      page_views: pageViews,
      users,
      engaged_sessions: engaged,
      by_day,
      top_sources,
      top_pages,
      events: eventTotals
    });
  } catch (e) {
    return res.status(200).json({
      configured: true,
      error: e.message,
      sessions: 0,
      page_views: 0,
      users: 0,
      by_day: {},
      top_sources: [],
      top_pages: [],
      events: {}
    });
  }
}
