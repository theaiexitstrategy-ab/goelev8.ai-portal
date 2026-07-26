#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot: seed konquered-balance + konquered-kocktails clients rows
// AND apply the slug-scoped tenant-config UPDATEs (portal_tabs,
// platform_fee_pct, brand_color, timezone, pickup_*, portal_api_key).
//
// Runs the same logic as:
//   POST /api/admin?action=ensure-default-clients
//   POST /api/admin?action=ensure-schema  (subset — only the KB/KK bits)
// but hits Supabase directly with the service role key, so it works
// without a portal admin browser session. Idempotent — safe to re-run.
//
// Run:
//   node scripts/seed-kb-kk-tenants.mjs

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY (checked env + .env)');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const REQUIRED = [
  { slug: 'konquered-balance',   name: 'Konquered Balance',   business_name: 'Konquered Balance LLC' },
  { slug: 'konquered-kocktails', name: 'Konquered Kocktails', business_name: 'Konquered Kocktails LLC' }
];

console.log('\n── Step 1: seed clients rows ──────────────────');
for (const r of REQUIRED) {
  const { data: existing } = await sb.from('clients')
    .select('id, slug, name, business_name').eq('slug', r.slug).maybeSingle();
  if (existing) {
    console.log(`  ✓ ${r.slug} already exists (id=${existing.id})`);
    if (!existing.business_name) {
      await sb.from('clients').update({ business_name: r.business_name }).eq('id', existing.id);
      console.log(`    backfilled business_name`);
    }
  } else {
    let { data: inserted, error } = await sb.from('clients').insert(r).select().single();
    if (error && /column .*business_name.* does not exist/i.test(error.message || '')) {
      const { business_name, ...trimmed } = r;
      const retry = await sb.from('clients').insert(trimmed).select().single();
      inserted = retry.data; error = retry.error;
    }
    if (error) { console.error(`  ✗ ${r.slug} insert failed:`, error.message); continue; }
    console.log(`  ✓ ${r.slug} inserted (id=${inserted.id})`);
  }
}

console.log('\n── Step 2: fetch rows ─────────────────────────');
const { data: kb } = await sb.from('clients').select('*').eq('slug', 'konquered-balance').maybeSingle();
const { data: kk } = await sb.from('clients').select('*').eq('slug', 'konquered-kocktails').maybeSingle();
console.log(`  KB: id=${kb?.id}  tabs=${JSON.stringify(kb?.portal_tabs)}`);
console.log(`  KK: id=${kk?.id}  tabs=${JSON.stringify(kk?.portal_tabs)}`);

// Sanity: are the 0035 experience-platform tables there?
const { error: probeErr } = await sb.from('experience_bookings').select('id').limit(1);
const schemaReady = !probeErr || !/relation .*experience_bookings.* does not exist/i.test(probeErr.message || '');
console.log(`  0035 experience_* schema present: ${schemaReady}`);
if (!schemaReady) {
  console.log(`  ⚠ experience_bookings table missing — run the migration or hit /api/admin?action=ensure-schema before the KB dashboard will work.`);
}

console.log('\n── Step 3: KB slug-scoped config ──────────────');
if (kb) {
  const KB_TABS = ['overview','leads','experience_bookings','experience_availability','messaging','analytics','settings'];
  const patch = {};
  if (JSON.stringify(kb.portal_tabs) !== JSON.stringify(KB_TABS)) patch.portal_tabs = KB_TABS;
  if (kb.platform_fee_pct == null) patch.platform_fee_pct = 10;
  if (Object.keys(patch).length) {
    const { error } = await sb.from('clients').update(patch).eq('id', kb.id);
    if (error) console.error('  ✗ KB update failed:', error.message);
    else       console.log(`  ✓ KB patched:`, Object.keys(patch).join(', '));
  } else {
    console.log('  ✓ KB already up-to-date');
  }
}

console.log('\n── Step 4: KK slug-scoped config ──────────────');
if (kk) {
  // Update one column at a time so a single missing column (older
  // schema) doesn't kill the whole patch. Prints ✓ per column that
  // stuck, ⚠ per column that's not in this DB.
  const KK_TABS = ['overview','leads','merch','messaging','bookings','analytics','settings'];
  const wanted = [
    ['portal_tabs',     JSON.stringify(kk.portal_tabs) !== JSON.stringify(KK_TABS) ? KK_TABS : undefined],
    ['platform_fee_pct', kk.platform_fee_pct == null ? 10 : undefined],
    ['brand_color',     !kk.brand_color ? '#C39A45' : undefined],
    ['timezone',        !kk.timezone ? 'America/Chicago' : undefined],
    ['pickup_enabled',  kk.pickup_enabled !== true ? true : undefined],
    ['pickup_location', !kk.pickup_location ? '920 Hemsath, Suite 100, St. Charles, MO 63303' : undefined]
  ];
  for (const [col, val] of wanted) {
    if (val === undefined) continue;
    const { error } = await sb.from('clients').update({ [col]: val }).eq('id', kk.id);
    if (error && /column .* does not exist|schema cache/i.test(error.message || '')) {
      console.log(`  ⚠ ${col}: column missing on this DB — skipped`);
    } else if (error) {
      console.error(`  ✗ ${col}:`, error.message);
    } else {
      console.log(`  ✓ ${col}: set`);
    }
  }
  if (!kk.portal_api_key) {
    const key = 'kk_' + randomBytes(24).toString('hex');
    const { error } = await sb.from('clients').update({ portal_api_key: key }).eq('id', kk.id);
    if (error) console.error('  ✗ portal_api_key:', error.message);
    else       console.log(`  ✓ portal_api_key: minted (prefix kk_${key.slice(3, 11)}…)`);
  } else {
    console.log('  ✓ portal_api_key: already set');
  }
}

console.log('\n── Step 5: verify ─────────────────────────────');
for (const slug of ['konquered-balance', 'konquered-kocktails']) {
  const { data: c, error } = await sb.from('clients')
    .select('*').eq('slug', slug).maybeSingle();
  console.log(`\n  ${slug}:`);
  if (error) { console.log('    ✗ query error:', error.message); continue; }
  if (!c)    { console.log('    ✗ MISSING'); continue; }
  console.log(`    id            = ${c.id}`);
  console.log(`    name          = ${c.name}`);
  console.log(`    business_name = ${c.business_name ?? '—'}`);
  console.log(`    portal_tabs   = ${JSON.stringify(c.portal_tabs)}`);
  console.log(`    fee_pct       = ${c.platform_fee_pct ?? '—'}`);
  console.log(`    brand_color   = ${c.brand_color ?? '—'}`);
  console.log(`    tz            = ${c.timezone ?? '(column not on this DB)'}`);
  console.log(`    pickup        = ${c.pickup_enabled ?? '?'}  @  ${c.pickup_location ?? '—'}`);
  console.log(`    stripe_acct   = ${c.stripe_connected_account_id || '(none — needs OAuth)'}`);
  console.log(`    logo_url      = ${c.logo_url || '(none — run upload-logos.mjs)'}`);
}

console.log('\n✅ Done.\n');
