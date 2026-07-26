#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot: fold the konquered-kocktails tenant into konquered-balance.
// KK was seeded briefly on 2026-07-25 as a separate merch tenant, but
// having two portals for the same business (Stephen Simmons) was
// confusing. This script:
//   1. Copies any config from KK onto KB where KB is missing it
//      (brand_color, pickup_enabled, pickup_location, portal_api_key,
//      stripe_connected_account_id, logo_url).
//   2. Adds 'merch' to KB's portal_tabs.
//   3. Deletes the KK clients row (cascades any FK dependents, though
//      there shouldn't be any — KK was never linked to a user or
//      populated with merch_products).
//
// Idempotent — safe to re-run.
//
// Storefront (konqueredkocktails.com/merch) will need
// NEXT_PUBLIC_PORTAL_SLUG changed from 'konquered-kocktails' to
// 'konquered-balance' on the KK repo's Vercel project.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

console.log('\n── Step 1: fetch both rows ────────────────────');
const { data: kb } = await sb.from('clients').select('*').eq('slug', 'konquered-balance').maybeSingle();
const { data: kk } = await sb.from('clients').select('*').eq('slug', 'konquered-kocktails').maybeSingle();

if (!kb) { console.error('❌ konquered-balance row missing — nothing to fold into.'); process.exit(1); }
console.log(`  KB: id=${kb.id}  tabs=${JSON.stringify(kb.portal_tabs)}`);
if (!kk) {
  console.log('  KK: already gone — nothing to fold. Ensuring KB tabs include merch and exiting.');
} else {
  console.log(`  KK: id=${kk.id}  tabs=${JSON.stringify(kk.portal_tabs)}`);
}

console.log('\n── Step 2: copy config KK → KB where KB missing ─');
// Columns to fold (only overwrite KB's value if it's null/empty AND
// KK has a value). Order: prefer KB's existing setting; KK is a
// fallback source.
const foldCols = ['brand_color', 'pickup_enabled', 'pickup_location', 'portal_api_key', 'stripe_connected_account_id', 'logo_url', 'owner_email', 'owner_phone', 'owner_name'];
if (kk) {
  for (const col of foldCols) {
    const kbVal = kb[col];
    const kkVal = kk[col];
    const kbEmpty = kbVal == null || kbVal === '' || kbVal === false;
    if (!kbEmpty || !kkVal) continue;
    const { error } = await sb.from('clients').update({ [col]: kkVal }).eq('id', kb.id);
    if (error && /column .* does not exist|schema cache/i.test(error.message || '')) {
      console.log(`  ⚠ ${col}: column missing on this DB — skipped`);
    } else if (error) {
      console.error(`  ✗ ${col}: ${error.message}`);
    } else {
      // Print sensitive values with masking.
      const shown = /api_key|stripe_connected/.test(col) && typeof kkVal === 'string'
        ? kkVal.slice(0, 8) + '…' : kkVal;
      console.log(`  ✓ ${col}: copied to KB (${shown})`);
    }
  }
} else {
  console.log('  (skipped — no KK row)');
}

// Ensure KB's portal_api_key uses kb_ prefix if we didn't just copy
// a kk_-prefixed one across. (Purely cosmetic — key validity is
// prefix-agnostic — but keeps grep-ability consistent.)
{
  const { data: kbNow } = await sb.from('clients').select('portal_api_key').eq('id', kb.id).maybeSingle();
  if (!kbNow?.portal_api_key) {
    const newKey = 'kb_' + randomBytes(16).toString('hex');
    await sb.from('clients').update({ portal_api_key: newKey }).eq('id', kb.id);
    console.log(`  ✓ portal_api_key: minted (prefix kb_${newKey.slice(3, 11)}…)`);
  }
}

console.log('\n── Step 3: add merch to KB portal_tabs ────────');
const KB_TABS_WITH_MERCH = ['overview','leads','experience_bookings','experience_availability','merch','messaging','analytics','settings'];
const { data: kbCurr } = await sb.from('clients').select('portal_tabs').eq('id', kb.id).maybeSingle();
if (JSON.stringify(kbCurr?.portal_tabs) !== JSON.stringify(KB_TABS_WITH_MERCH)) {
  const { error } = await sb.from('clients').update({ portal_tabs: KB_TABS_WITH_MERCH }).eq('id', kb.id);
  if (error) console.error('  ✗ portal_tabs update failed:', error.message);
  else       console.log('  ✓ portal_tabs updated (8 tabs, merch inserted)');
} else {
  console.log('  ✓ portal_tabs already correct');
}

console.log('\n── Step 4: delete KK row ──────────────────────');
if (kk) {
  // Safety check — count anything that might depend on KK before deleting.
  const dependents = {};
  for (const table of ['client_users', 'merch_products', 'merch_orders', 'tenant_write_keys']) {
    try {
      const { count } = await sb.from(table).select('*', { count: 'exact', head: true }).eq('client_id', kk.id);
      if (count) dependents[table] = count;
    } catch { /* table might not exist on this DB */ }
  }
  if (Object.keys(dependents).length) {
    console.log(`  ⚠ KK has dependent rows: ${JSON.stringify(dependents)}`);
    console.log('    ON DELETE CASCADE will remove them. Continuing.');
  } else {
    console.log('  ✓ no dependent rows found');
  }
  const { error } = await sb.from('clients').delete().eq('id', kk.id);
  if (error) console.error('  ✗ delete failed:', error.message);
  else       console.log(`  ✓ KK row deleted (id=${kk.id})`);
} else {
  console.log('  (already gone)');
}

console.log('\n── Step 5: verify ─────────────────────────────');
const { data: kbFinal } = await sb.from('clients').select('*').eq('slug', 'konquered-balance').maybeSingle();
const { data: kkGone }  = await sb.from('clients').select('id').eq('slug', 'konquered-kocktails').maybeSingle();
console.log(`\n  konquered-balance:`);
console.log(`    id            = ${kbFinal.id}`);
console.log(`    portal_tabs   = ${JSON.stringify(kbFinal.portal_tabs)}`);
console.log(`    brand_color   = ${kbFinal.brand_color || '—'}`);
console.log(`    pickup        = ${kbFinal.pickup_enabled ?? '?'}  @  ${kbFinal.pickup_location || '—'}`);
console.log(`    portal_api_key= ${kbFinal.portal_api_key ? kbFinal.portal_api_key.slice(0, 11) + '…' : '(none)'}`);
console.log(`    stripe_acct   = ${kbFinal.stripe_connected_account_id || '(needs OAuth)'}`);
console.log(`    logo_url      = ${kbFinal.logo_url ? 'set' : '(none)'}`);
console.log(`\n  konquered-kocktails: ${kkGone ? '✗ STILL PRESENT' : '✓ deleted'}`);

console.log('\n✅ Done.');
console.log('   Storefront TODO: change NEXT_PUBLIC_PORTAL_SLUG on the');
console.log('   konqueredkocktails.com Vercel project from');
console.log("     'konquered-kocktails'  →  'konquered-balance'");
console.log('   then redeploy the storefront.\n');
