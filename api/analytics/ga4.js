// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// GA4 Data API proxy — returns pageviews, sessions, active users
// Cached for 1 hour to avoid API limits. Falls back to N/A if unavailable.

import { requireUser } from '../../lib/auth.js';

// In-memory cache (per-serverless-instance)
let cache = { data: null, ts: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchGA4Data() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const serviceAccountKey = process.env.GA4_SERVICE_ACCOUNT_KEY;

  if (!propertyId || !serviceAccountKey) {
    return null;
  }

  try {
    const key = JSON.parse(serviceAccountKey);
    // Build JWT for Google service account
    const now = Math.floor(Date.now() / 1000);
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    }));

    // Sign with crypto (Node.js)
    const crypto = await import('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(key.private_key, 'base64url');
    const jwt = `${header}.${payload}.${signature}`;

    // Exchange JWT for access token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return null;

    // Run GA4 Data API report
    const reportRes = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
          dimensions: [{ name: 'pagePath' }],
          metrics: [
            { name: 'screenPageViews' },
            { name: 'sessions' },
            { name: 'activeUsers' },
            { name: 'averageSessionDuration' }
          ]
        })
      }
    );
    const report = await reportRes.json();

    // Parse results
    const rows = report.rows || [];
    let totalPageviews = 0;
    let totalSessions = 0;
    let totalUsers = 0;
    let totalDuration = 0;
    let durationCount = 0;
    const pageViews = {};
    const sources = {};

    for (const row of rows) {
      const page = row.dimensionValues?.[0]?.value || '';
      const pv = parseInt(row.metricValues?.[0]?.value || '0', 10);
      const sess = parseInt(row.metricValues?.[1]?.value || '0', 10);
      const users = parseInt(row.metricValues?.[2]?.value || '0', 10);
      const dur = parseFloat(row.metricValues?.[3]?.value || '0');

      totalPageviews += pv;
      totalSessions += sess;
      totalUsers += users;
      totalDuration += dur;
      durationCount++;
      pageViews[page] = (pageViews[page] || 0) + pv;
    }

    // Funnel page views for specific pages
    const funnelPages = {
      '/fit': pageViews['/fit'] || 0,
      '/rs2': pageViews['/rs2'] || 0,
      '/': pageViews['/'] || 0,
      '/thank-you': pageViews['/thank-you'] || 0
    };

    // Active users today — run a separate quick query
    let activeToday = 0;
    try {
      const todayRes = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            dateRanges: [{ startDate: 'today', endDate: 'today' }],
            metrics: [{ name: 'activeUsers' }]
          })
        }
      );
      const todayData = await todayRes.json();
      activeToday = parseInt(todayData.rows?.[0]?.metricValues?.[0]?.value || '0', 10);
    } catch {}

    return {
      total_pageviews: totalPageviews,
      total_sessions: totalSessions,
      total_users: totalUsers,
      avg_session_duration: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
      active_today: activeToday,
      funnel_pages: funnelPages,
      page_views: pageViews,
      fetched_at: new Date().toISOString()
    };
  } catch (e) {
    console.error('GA4 fetch error:', e);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const ctx = await requireUser(req, res);
  if (!ctx) return;

  // Return cached data if fresh
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    return res.json(cache.data);
  }

  const data = await fetchGA4Data();
  if (data) {
    cache = { data, ts: Date.now() };
    return res.json(data);
  }

  // Fallback when GA4 is unavailable
  return res.json({
    total_pageviews: 'N/A',
    total_sessions: 'N/A',
    total_users: 'N/A',
    avg_session_duration: 'N/A',
    active_today: 'N/A',
    funnel_pages: {},
    page_views: {},
    fetched_at: null,
    unavailable: true
  });
}
