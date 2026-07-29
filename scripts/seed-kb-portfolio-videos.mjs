#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot: seed the three Konquered Balance portfolio videos so the
// portal matches what the KK site's built-in seed reel is showing on
// 2026-07-29. Idempotent — re-runs upsert on (client_id, video_key).
//
// Verifies each Mux playback ID with a HEAD check before writing, so
// a rotated/private ID would fail loudly here instead of silently
// producing a dead player on the live page.
//
// Run:
//   node scripts/seed-kb-portfolio-videos.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const CLIENT_SLUG = 'konquered-balance';
const VIDEOS = [
  {
    video_key: 'gentleman-jack-2021',
    title:     "Jack Daniel's Gentleman Jack — Culture Shakers",
    description: null,
    mux_playback_id: 'MOxiZEb302JK1hwfkQzUQU3EDriQ401stR1CoSrTx02lq00',
    sort_order: 0
  },
  {
    // PLACEHOLDER TITLE — Stephen should rename this in the portal.
    // The clip has no description on record.
    video_key: 'behind-the-bar',
    title:     'Behind the Bar',
    description: null,
    mux_playback_id: 'mSxkyXsJ3QPl201AEmwymMEw4iOLASE00x7zL3g9lygi4',
    sort_order: 1,
    _flagPlaceholderTitle: true
  },
  {
    video_key: 'from-the-studio',
    title:     'From the Studio',
    description: null,
    mux_playback_id: 'aJAE59oLfQgbyWqAY1cs9avjbrCg6FsIJunL8cNr5nw',
    sort_order: 2
  }
];

console.log('\n── Step 1: verify KB tenant ───────────────────');
const { data: client, error: clientErr } = await sb.from('clients')
  .select('id, slug, name').eq('slug', CLIENT_SLUG).maybeSingle();
if (clientErr) { console.error('❌ clients lookup failed:', clientErr.message); process.exit(1); }
if (!client)   { console.error(`❌ tenant '${CLIENT_SLUG}' not found`); process.exit(1); }
console.log(`  ✓ ${client.slug} → id=${client.id}`);

console.log('\n── Step 2: HEAD-check each Mux playback ID ────');
async function headCheck(id) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const [s, i] = await Promise.all([
      fetch(`https://stream.mux.com/${encodeURIComponent(id)}.m3u8`, { method: 'HEAD', signal: ac.signal }),
      fetch(`https://image.mux.com/${encodeURIComponent(id)}/thumbnail.jpg`, { method: 'HEAD', signal: ac.signal })
    ]);
    clearTimeout(t);
    return { stream: s.status, thumb: i.status };
  } catch (e) { clearTimeout(t); return { error: e?.message || 'network' }; }
}
for (const v of VIDEOS) {
  const r = await headCheck(v.mux_playback_id);
  if (r.error) { console.error(`  ✗ ${v.video_key}: ${r.error}`); process.exit(1); }
  const ok = r.stream === 200 && r.thumb === 200;
  console.log(`  ${ok ? '✓' : '✗'} ${v.video_key}: stream=${r.stream} thumb=${r.thumb}`);
  if (!ok) { console.error('    Aborting seed — a Mux ID would not have streamed.'); process.exit(1); }
}

console.log('\n── Step 3: upsert into client_portfolio_videos ─');
for (const v of VIDEOS) {
  const { data: existing } = await sb.from('client_portfolio_videos')
    .select('id, title, mux_playback_id, sort_order, is_active')
    .eq('client_id', client.id).eq('video_key', v.video_key).maybeSingle();
  const row = {
    client_id:       client.id,
    video_key:       v.video_key,
    title:           v.title,
    description:     v.description,
    mux_playback_id: v.mux_playback_id,
    is_active:       true,
    sort_order:      v.sort_order
  };
  if (existing) {
    // Preserve title / description if the operator has edited them
    // (don't clobber Stephen's rename of "Behind the Bar" on re-run).
    const patch = {
      mux_playback_id: v.mux_playback_id,   // safe to refresh
      sort_order:      v.sort_order,        // authoritative from seed
      is_active:       true
    };
    const { error } = await sb.from('client_portfolio_videos').update(patch).eq('id', existing.id);
    if (error) console.error(`  ✗ ${v.video_key} update:`, error.message);
    else       console.log(`  ✓ ${v.video_key}: refreshed (kept operator-edited title="${existing.title}")`);
  } else {
    const { error } = await sb.from('client_portfolio_videos').insert(row);
    if (error) console.error(`  ✗ ${v.video_key} insert:`, error.message);
    else       console.log(`  ✓ ${v.video_key}: inserted`);
  }
}

console.log('\n── Step 4: final state ────────────────────────');
const { data: all } = await sb.from('client_portfolio_videos').select('*')
  .eq('client_id', client.id).order('sort_order');
for (const v of all || []) {
  console.log(`  ${v.sort_order}: "${v.title}" [${v.is_active ? 'active' : 'inactive'}] pb=${v.mux_playback_id.slice(0, 12)}…`);
}

console.log('\n✅ Done.');
const placeholder = VIDEOS.find(v => v._flagPlaceholderTitle);
if (placeholder) {
  console.log(`\n⚠ Placeholder title on record for "${placeholder.title}" (video_key=${placeholder.video_key}).`);
  console.log('   Ask Stephen to rename it via the portal Portfolio tab.\n');
}
