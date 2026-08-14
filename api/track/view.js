// POST /api/track/view
// Public endpoint — fires from client websites / funnel pages.
// No auth required. Rate limited: 1 insert per IP per slug per 60 minutes.
//
// CORS (added 2026-08-14): this endpoint previously sent no CORS headers
// and had no OPTIONS branch, so EVERY cross-origin call was dropped by
// the browser — including the sendBeacon path, because embed/track.js
// posts a Blob typed 'application/json' and that content type is not
// CORS-safelisted, so beacons get preflighted too. Page views from every
// tenant site have been silently failing; see lib/public-cors.js.

import { supabaseAdmin } from '../../lib/supabase.js';
import { handlePreflight } from '../../lib/public-cors.js';

// In-memory rate limit cache (resets on cold start, which is fine).
const seen = new Map();
const RATE_LIMIT_MS = 60 * 60 * 1000; // 60 minutes

// Rate limit per (ip, slug, path) instead of per (ip, slug) so a
// single visitor browsing multiple pages within an hour still
// generates the per-page view rows the Analytics tab needs.
function isRateLimited(ip, slug, path) {
  const key = ip + ':' + slug + ':' + (path || '/');
  const last = seen.get(key);
  if (last && Date.now() - last < RATE_LIMIT_MS) return true;
  seen.set(key, Date.now());
  // Prevent memory leak: cap at 10k entries
  if (seen.size > 10000) {
    const first = seen.keys().next().value;
    seen.delete(first);
  }
  return false;
}

// Normalize path: strip query + hash, lowercase, cap to 200 chars,
// collapse trailing slash. Keeps /MERCH, /merch?ref=ad, /merch/ all
// rolling up under one bucket in the Analytics tab.
function normalizePath(raw) {
  if (typeof raw !== 'string') return '/';
  let p = raw.split('?')[0].split('#')[0].trim().toLowerCase();
  if (!p) return '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 200);
}

export default async function handler(req, res) {
  // Preflight first — must answer before any method check, otherwise the
  // OPTIONS request falls through to the 200 below without CORS headers
  // and the browser never sends the real POST.
  if (handlePreflight(req, res)) return;

  // Always return success to the client — never block render.
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    let body;
    if (req.body && typeof req.body === 'object') {
      body = req.body;
    } else if (typeof req.body === 'string') {
      // Vercel hands us a pre-read string for non-JSON content types.
      // The stream is already consumed at this point, so re-reading it
      // below would hang or yield '' — parse what we were given.
      try { body = JSON.parse(req.body); } catch { body = {}; }
    } else {
      body = await new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch { resolve({}); }
        });
        req.on('error', () => resolve({}));
      });
    }

    const { slug, client_id, referrer, user_agent } = body;
    if (!slug && !client_id) return res.status(200).json({ ok: true });
    const path = normalizePath(body.path);

    // Rate limit check — scoped per (ip, slug, path) so visitors
    // browsing multiple pages still register one row per page.
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || 'unknown';
    if (isRateLimited(ip, slug || client_id, path)) {
      return res.status(200).json({ ok: true });
    }

    // Resolve client_id from slug if only slug provided
    let resolvedClientId = client_id;
    if (!resolvedClientId && slug) {
      const { data } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('slug', slug)
        .maybeSingle();
      resolvedClientId = data?.id;
    }

    if (!resolvedClientId) return res.status(200).json({ ok: true });

    // Insert view. Tolerant retry without `path` for pre-migration
    // projects so we never break the public tracker.
    const row = {
      client_id: resolvedClientId,
      slug: slug || '',
      path,
      referrer: referrer || null,
      user_agent: user_agent || null
    };
    let { error: insErr } = await supabaseAdmin.from('funnel_views').insert(row);
    if (insErr && /column .*path.* does not exist/i.test(insErr.message || '')) {
      const { path: _drop, ...legacy } = row;
      await supabaseAdmin.from('funnel_views').insert(legacy);
    }

    return res.status(200).json({ ok: true });
  } catch {
    // Never error to the client
    return res.status(200).json({ ok: true });
  }
}
