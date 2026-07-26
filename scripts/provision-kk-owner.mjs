#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot: provision Stephen Simmons as owner of Konquered Balance.
// (Originally provisioned two tenants — merch + bookings — but they
// were folded into a single 'konquered-balance' tenant on 2026-07-26
// so only one client_users link is needed now.)
//
// Mirrors scripts/provision-freeflow-owner.mjs:
//   1. Look up both clients rows (must exist via ensureDefaultClients).
//   2. Create Supabase auth user for stephen@konqueredbalance.com.
//      Idempotent — falls back to listUsers + updateUserById on re-run.
//   3. Backfill clients.owner_email + owner_phone on both rows so
//      the notification helpers (lib/experience-notify.js, merch push
//      handlers) can reach him.
//   4. Insert one client_users row per tenant with role='owner'.
//
// Run once:
//   PowerShell:
//     $env:SUPABASE_URL="https://bnkoqybkmwtrlorhowyv.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY="eyJhbG..."
//     node scripts/provision-kk-owner.mjs
//   Bash:
//     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//       node scripts/provision-kk-owner.mjs
//
// Env vars also picked up from .env.local via dotenv/config.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const OWNER_EMAIL = 'stephen@konqueredbalance.com';
const OWNER_PASS  = process.env.KB_OWNER_PASSWORD || 'Konquered123!!!';
const OWNER_NAME  = 'Stephen Simmons';
const OWNER_PHONE = '+13145039198';
const SLUGS       = ['konquered-balance'];

console.log(`\nProvisioning ${OWNER_EMAIL} → ${SLUGS.join(' + ')}`);

// Step 1: find both clients rows.
const { data: clients, error: clientsErr } = await sb
  .from('clients').select('id, slug, name').in('slug', SLUGS);
if (clientsErr) { console.error('❌ clients lookup failed:', clientsErr.message); process.exit(1); }
if (!clients || clients.length !== SLUGS.length) {
  const found = new Set((clients || []).map(c => c.slug));
  const missing = SLUGS.filter(s => !found.has(s));
  console.error(`❌ Missing clients rows for: ${missing.join(', ')}. Run ensureDefaultClients first (hit Master Admin once), then re-run.`);
  process.exit(1);
}
for (const c of clients) console.log(`  ✓ clients row: ${c.slug} → id=${c.id}`);

// Step 2: create (or find) the auth user.
let userId = null;
{
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASS,
    email_confirm: true,
    phone: OWNER_PHONE.replace(/[^\d+]/g, ''),
    user_metadata: { full_name: OWNER_NAME }
  });
  if (created?.user?.id) {
    userId = created.user.id;
    console.log(`  ✓ auth user created: ${userId}`);
  } else if (createErr && /already been registered|already exists|user_already_exists/i.test(createErr.message || '')) {
    let page = 1;
    while (!userId && page < 20) {
      const { data: list } = await sb.auth.admin.listUsers({ page, perPage: 200 });
      const found = (list?.users || []).find(u => (u.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase());
      if (found) userId = found.id;
      if (!list?.users?.length || list.users.length < 200) break;
      page++;
    }
    if (!userId) { console.error('❌ user email exists but listUsers could not find it'); process.exit(1); }
    console.log(`  ✓ auth user already exists: ${userId}`);
    const { error: pwErr } = await sb.auth.admin.updateUserById(userId, { password: OWNER_PASS });
    if (pwErr) console.log(`  ⚠ password reset failed: ${pwErr.message}`);
    else       console.log(`  ✓ password reset to ${OWNER_PASS}`);
  } else {
    console.error('❌ createUser failed:', createErr?.message || 'unknown');
    process.exit(1);
  }
}

// Step 3: backfill owner_email + owner_phone on both tenants so the
// notification path (experience_bookings + merch-ingest) can reach him
// even before he sets them via the Settings UI. Tolerant of missing
// columns (older schemas).
for (const c of clients) {
  const patch = { owner_email: OWNER_EMAIL, owner_phone: OWNER_PHONE, owner_name: OWNER_NAME };
  let { error } = await sb.from('clients').update(patch).eq('id', c.id);
  if (error && /column .*(owner_email|owner_phone|owner_name).* does not exist/i.test(error.message || '')) {
    // Retry with only whichever columns exist. Cheapest: try each.
    for (const k of Object.keys(patch)) {
      await sb.from('clients').update({ [k]: patch[k] }).eq('id', c.id)
        .then(() => {}, () => {});
    }
    console.log(`  ⚠ owner_* backfill partial for ${c.slug} (older schema)`);
  } else if (error) {
    console.log(`  ⚠ owner_* backfill failed for ${c.slug}: ${error.message}`);
  } else {
    console.log(`  ✓ owner_* backfilled on ${c.slug}`);
  }
}

// Step 4: link user → each client via client_users. Upsert on (user_id, client_id).
for (const c of clients) {
  const { error: linkErr } = await sb
    .from('client_users')
    .upsert({ user_id: userId, client_id: c.id, role: 'owner' },
            { onConflict: 'user_id,client_id' });
  if (linkErr) {
    if (/on conflict specification|no unique/i.test(linkErr.message || '')) {
      const { data: existing } = await sb.from('client_users')
        .select('user_id').eq('user_id', userId).eq('client_id', c.id).maybeSingle();
      if (!existing) {
        const { error: insErr } = await sb.from('client_users')
          .insert({ user_id: userId, client_id: c.id, role: 'owner' });
        if (insErr) { console.error(`❌ client_users insert failed for ${c.slug}:`, insErr.message); process.exit(1); }
      }
      console.log(`  ✓ client_users link ensured for ${c.slug} (fallback)`);
    } else {
      console.error(`❌ client_users upsert failed for ${c.slug}:`, linkErr.message);
      process.exit(1);
    }
  } else {
    console.log(`  ✓ client_users link: owner on ${c.slug}`);
  }
}

console.log('\n✅ Done.');
console.log(`   Stephen can now log in at https://portal.goelev8.ai with:`);
console.log(`     email:    ${OWNER_EMAIL}`);
console.log(`     password: ${OWNER_PASS}`);
console.log(`   He should see BOTH tenants in his account switcher.`);
console.log(`   Tell him to change the password in Settings on first login.\n`);
