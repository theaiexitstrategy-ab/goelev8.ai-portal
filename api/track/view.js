// POST /api/track/view
// Public endpoint — fires from client websites / funnel pages.
// No auth required. Rate limited: 1 insert per IP per slug per 60 minutes.

import { supabaseAdmin } from '../../lib/supabase.js';

// In-memory rate limit cache (resets on cold start, which is fine).
const seen = new Map();
const RATE_LIMIT_MS = 60 * 60 * 1000; // 60 minutes

function isRateLimited(ip, slug) {
  const key = ip + ':' + slug;
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

export default async function handler(req, res) {
  // Always return success to the client — never block render.
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  try {
    let body;
    if (req.body && typeof req.body === 'object') {
      body = req.body;
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

    // Rate limit check
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.headers['x-real-ip']
      || 'unknown';
    if (isRateLimited(ip, slug || client_id)) {
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

    // Insert view
    await supabaseAdmin.from('funnel_views').insert({
      client_id: resolvedClientId,
      slug: slug || '',
      referrer: referrer || null,
      user_agent: user_agent || null
    });

    return res.status(200).json({ ok: true });
  } catch {
    // Never error to the client
    return res.status(200).json({ ok: true });
  }
}
