#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot: provision Adrianne Martin as the Free Flow Fitness tenant
// owner. Same pattern as scripts/onboard-taes-atbhr.mjs:
//   1. Look up the freeflow-fitness-stl clients row (must exist —
//      ensureDefaultClients seeds it on first Master Admin load).
//   2. Create a Supabase auth user for amartin@anudaytherapy.com with
//      the given password. Idempotent — finds the existing user if
//      the email is already taken and doesn't fail.
//   3. Link user → client via public.client_users with role='owner'.
//      Uses upsert so re-runs are safe.
//
// Adrianne can then log into portal.goelev8.ai with these creds and
// impersonation is NOT required — she sees Free Flow Fitness's portal
// directly.
//
// Run once:
//   PowerShell:
//     $env:SUPABASE_URL="https://bnkoqybkmwtrlorhowyv.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY="eyJhbG..."
//     node scripts/provision-freeflow-owner.mjs
//   Bash:
//     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//       node scripts/provision-freeflow-owner.mjs
//
// Env vars are also picked up from .env.local (dotenv/config).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  console.error('   Both are in the portal repo\'s Vercel env vars or in .env.local.');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const CLIENT_SLUG = 'freeflow-fitness-stl';
const OWNER_EMAIL = 'amartin@anudaytherapy.com';
const OWNER_PASS  = 'Flow123!!!';
const OWNER_NAME  = 'Adrianne Martin';

console.log(`\nProvisioning ${OWNER_EMAIL} → ${CLIENT_SLUG}`);

// Step 1: find the clients row.
const { data: client, error: clientErr } = await sb
  .from('clients').select('id, slug, name').eq('slug', CLIENT_SLUG).maybeSingle();
if (clientErr) { console.error('❌ clients lookup failed:', clientErr.message); process.exit(1); }
if (!client)   {
  console.error(`❌ No clients row with slug='${CLIENT_SLUG}'. Load the Master Admin panel once so ensureDefaultClients seeds it, then re-run.`);
  process.exit(1);
}
console.log(`  ✓ clients row: id=${client.id} name="${client.name}"`);

// Step 2: create (or find) the auth user. Supabase admin API's
// createUser 422s when the email is already registered; we catch that
// and fall back to listUsers to find the existing id.
let userId = null;
{
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email: OWNER_EMAIL,
    password: OWNER_PASS,
    email_confirm: true,        // no confirmation email needed — admin-provisioned
    user_metadata: { full_name: OWNER_NAME }
  });
  if (created?.user?.id) {
    userId = created.user.id;
    console.log(`  ✓ auth user created: ${userId}`);
  } else if (createErr && /already been registered|already exists|user_already_exists/i.test(createErr.message || '')) {
    // Look up by email
    let page = 1;
    while (!userId && page < 20) {
      const { data: list } = await sb.auth.admin.listUsers({ page, perPage: 200 });
      const found = (list?.users || []).find(u => (u.email || '').toLowerCase() === OWNER_EMAIL.toLowerCase());
      if (found) userId = found.id;
      if (!list?.users?.length || list.users.length < 200) break;
      page++;
    }
    if (!userId) { console.error('❌ user email already exists but listUsers could not find it'); process.exit(1); }
    console.log(`  ✓ auth user already exists: ${userId}`);
    // Reset password to the given value so Adrianne can log in with
    // exactly the creds Aaron shared. Idempotent — safe on re-run.
    const { error: pwErr } = await sb.auth.admin.updateUserById(userId, { password: OWNER_PASS });
    if (pwErr) console.log(`  ⚠ password reset failed: ${pwErr.message}`);
    else       console.log('  ✓ password reset to Flow123!!!');
  } else {
    console.error('❌ createUser failed:', createErr?.message || 'unknown');
    process.exit(1);
  }
}

// Step 3: link via client_users. Upsert on (user_id, client_id).
const { error: linkErr } = await sb
  .from('client_users')
  .upsert({ user_id: userId, client_id: client.id, role: 'owner' },
          { onConflict: 'user_id,client_id' });
if (linkErr) {
  // Fall back to insert-then-ignore if the composite conflict target
  // isn't declared as a unique index on this DB (older schemas).
  if (/on conflict specification|no unique/i.test(linkErr.message || '')) {
    const { data: existingLink } = await sb.from('client_users')
      .select('user_id').eq('user_id', userId).eq('client_id', client.id).maybeSingle();
    if (!existingLink) {
      const { error: insErr } = await sb.from('client_users')
        .insert({ user_id: userId, client_id: client.id, role: 'owner' });
      if (insErr) { console.error('❌ client_users insert failed:', insErr.message); process.exit(1); }
    }
    console.log('  ✓ client_users link ensured (fallback path)');
  } else {
    console.error('❌ client_users upsert failed:', linkErr.message);
    process.exit(1);
  }
} else {
  console.log('  ✓ client_users link: owner');
}

console.log('\n✅ Done.');
console.log(`   Adrianne can now log in at https://portal.goelev8.ai with:`);
console.log(`     email:    ${OWNER_EMAIL}`);
console.log(`     password: ${OWNER_PASS}`);
console.log(`   Tell her to change the password in Settings on first login.\n`);
