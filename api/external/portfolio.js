// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Public read of a tenant's active portfolio videos. No auth — called
// from tenant marketing sites (first consumer: konqueredkocktails.com/
// portfolio). Storefront tolerates 4xx/5xx/malformed by keeping its
// built-in seed reel, so a broken endpoint fails invisibly on the
// page — verify with curl, not by loading the site.
//
// GET /api/external/portfolio?slug=konquered-balance
//   → 200 { videos: [{ key, title, description, playback_id,
//                      poster_url, sort_order }, ...] }
//
// Response shape frozen — the KonquredKocktails app/portfolio/
// PortfolioClient.tsx page reads these exact field names. Do not
// change without a coordinated storefront redeploy.

import { supabaseAdmin } from '../../lib/supabase.js';
import { resolveClientBySlug } from '../../lib/tenant-slug.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type'
};

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const slug = (url.searchParams.get('slug') || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug query param required' });

  const { data: client } = await resolveClientBySlug(slug, 'id');
  if (!client) return res.status(404).json({ error: 'tenant_not_found' });

  let { data, error } = await supabaseAdmin
    .from('client_portfolio_videos')
    .select('video_key, title, description, mux_playback_id, poster_url, sort_order')
    .eq('client_id', client.id)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  // Tolerant if migration hasn't been applied yet — same shape as
  // products.js so storefronts can distinguish "no videos" from
  // "portal not migrated".
  if (error && /relation .*client_portfolio_videos.* does not exist/i.test(error.message || '')) {
    return res.status(200).json({ videos: [], setup_required: true });
  }
  if (error) return res.status(500).json({ error: error.message });

  // Strip any row missing a playback_id defensively (also the
  // storefront's own filter — belt AND suspenders).
  const videos = (data || [])
    .filter(v => v.mux_playback_id && v.mux_playback_id.trim())
    .map(v => ({
      key:          v.video_key,
      title:        v.title,
      description:  v.description || null,
      playback_id:  v.mux_playback_id,
      poster_url:   v.poster_url || null,
      sort_order:   v.sort_order
    }));

  return res.status(200).json({ videos });
}
