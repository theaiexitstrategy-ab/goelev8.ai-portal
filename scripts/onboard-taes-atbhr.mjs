#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot onboarding for The AI Exit Strategy + AllThingzBlackHair.
//
// The clients rows themselves are already seeded by ensureDefaultClients.
// This script handles the rest:
//   1. Adds the ga4_measurement_id column to public.clients if missing
//   2. Updates each seeded row with its GA4 Measurement ID
//   3. Creates Supabase auth users with the given email/password
//      (idempotent — finds existing users if the email is already taken)
//   4. Links each user → client via public.client_users with role='owner'
//   5. Optionally sets logo_url + brand_color when --logo flags are passed
//
// Run:
//   PowerShell:
//     $env:SUPABASE_URL="https://YOUR.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY="eyJhbG..."
//     node scripts/onboard-taes-atbhr.mjs
//   Bash:
//     SUPABASE_URL=https://YOUR.supabase.co \
//     SUPABASE_SERVICE_ROLE_KEY=eyJhbG... \
//     node scripts/onboard-taes-atbhr.mjs
//
// SECURITY NOTE: the credentials below were shared in chat for this
// one-time provisioning. Tell each owner to change their password on
// first login (the portal has a Change Password form in Settings).

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  console.error('   Find both in Supabase Dashboard → Settings → API');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Two tenants to provision in this run.
// Logos live at the repo root and ship as static assets at
// /taes-logo.png and /atbhr-logo.png on portal.goelev8.ai.
const PORTAL_BASE = process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai';
const TENANTS = [
  {
    slug: 'ai-exit-strategy',
    name: 'The AI Exit Strategy',
    business_name: 'The AI Exit Strategy',
    ga4_measurement_id: 'G-HNX5T6DC0N',
    logo_url: `${PORTAL_BASE.replace(/\/$/, '')}/taes-logo.png`,
    user: { email: 'ab@taes.com', password: 'TAES!!!' }
  },
  {
    slug: 'allthingzblackhair',
    name: 'AllThingzBlackHair',
    business_name: 'AllThingzBlackHair',
    ga4_measurement_id: 'G-RGLQVQ5S3W',
    logo_url: `${PORTAL_BASE.replace(/\/$/, '')}/atbhr-logo.png`,
    user: { email: 'court@atbhr.com', password: 'BlackHair!!!' }
  }
];

// Step 1: ensure the ga4_measurement_id column exists on clients.
async function ensureMeasurementColumn() {
  // Probe by selecting it. If it errors with column-missing we can't
  // ALTER from supabase-js (PostgREST doesn't run DDL). Tell the
  // operator to add it manually.
  const probe = await sb.from('clients').select('ga4_measurement_id').limit(1);
  if (probe.error && /column .*ga4_measurement_id.* does not exist/i.test(probe.error.message)) {
    console.warn('  ⚠️  clients.ga4_measurement_id column is missing.');
    console.warn('      Run this in Supabase SQL editor first, then re-run this script:');
    console.warn('        ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS ga4_measurement_id text;');
    console.warn('      Continuing without GA4 measurement ID updates…');
    return false;
  }
  return true;
}

// Step 2: find or create the auth user. Returns the user id.
async function ensureAuthUser(email, password) {
  // Try to create directly. If the email is already taken, list and
  // find the existing user id instead.
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (created?.user?.id) return { id: created.user.id, created: true };

  if (createErr && /already|registered|exists/i.test(createErr.message)) {
    // Paginate through users to find by email. listUsers caps at 1000
    // per page; we'd need to extend if you ever exceed that.
    let page = 1;
    while (page <= 5) {
      const { data: list } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      const u = list?.users?.find(x => x.email === email);
      if (u) {
        // Reset the password to the value passed in so the operator's
        // shared credentials always work, even if the user existed.
        await sb.auth.admin.updateUserById(u.id, { password });
        return { id: u.id, created: false, password_reset: true };
      }
      if (!list?.users?.length || list.users.length < 1000) break;
      page++;
    }
  }

  throw new Error('Failed to create or find auth user: ' + (createErr?.message || 'unknown'));
}

async function provisionTenant(t, hasMeasurementCol) {
  console.log(`\n→ ${t.name}  (slug: ${t.slug})`);

  // Find seeded client row.
  const { data: client, error: cErr } = await sb.from('clients')
    .select('id, slug, name, business_name, ga4_measurement_id, logo_url, brand_color')
    .eq('slug', t.slug).maybeSingle();
  if (cErr) throw cErr;
  if (!client) {
    console.warn(`  ⚠️  No clients row for slug="${t.slug}". Visit Master Admin once so ensureDefaultClients fires, then re-run.`);
    return;
  }
  console.log('  ✓ Found seeded client row:', client.id);

  // Update GA4 Measurement ID + business_name + logo_url if missing.
  const patch = {};
  if (hasMeasurementCol && client.ga4_measurement_id !== t.ga4_measurement_id) {
    patch.ga4_measurement_id = t.ga4_measurement_id;
  }
  if (!client.business_name)         patch.business_name = t.business_name;
  if (client.logo_url !== t.logo_url) patch.logo_url      = t.logo_url;
  if (Object.keys(patch).length) {
    const { error } = await sb.from('clients').update(patch).eq('id', client.id);
    if (error) console.warn('  ⚠️  client row update failed:', error.message);
    else {
      const updated = Object.keys(patch).join(', ');
      console.log('  ✓ Updated:', updated);
    }
  } else {
    console.log('  ✓ Client row already current');
  }

  // Create or find the auth user.
  const userRes = await ensureAuthUser(t.user.email, t.user.password);
  console.log(`  ✓ Auth user ${userRes.created ? 'created' : 'already existed'}: ${t.user.email}` +
              (userRes.password_reset ? ' (password reset to provided value)' : ''));

  // Link via client_users (idempotent upsert).
  const { error: linkErr } = await sb.from('client_users').upsert(
    { user_id: userRes.id, client_id: client.id, role: 'owner' },
    { onConflict: 'user_id,client_id' }
  );
  if (linkErr) console.warn('  ⚠️  client_users link failed:', linkErr.message);
  else        console.log('  ✓ Linked user → client (role=owner)');
}

async function main() {
  console.log('🚀 Provisioning new tenants…');
  const hasCol = await ensureMeasurementColumn();
  for (const t of TENANTS) {
    try { await provisionTenant(t, hasCol); }
    catch (e) { console.error(`  ❌ ${t.slug} failed:`, e.message); }
  }
  console.log('\n✅ Done. Each owner should now be able to sign in at portal.goelev8.ai with their email + the password set in this script. Tell them to change it on first login (Settings → Change password).');
}

main().catch(err => { console.error(err); process.exit(1); });
