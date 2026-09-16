#!/usr/bin/env node
// Issue a per-client API key for the /api/external/* bearer-token
// endpoints (client_api_keys, migration 0029).
//
// The raw key is printed ONCE, here, and never stored — only its sha256
// hash goes into the table. If you lose it, revoke and issue a new one.
//
// Usage:
//   node scripts/issue-client-api-key.mjs \
//     --slug ai-exit-strategy \
//     --name "theaiexitstrategy.com /api/leads mirror" \
//     --prefix taes \
//     --scopes leads:write
//
//   # revoke instead of issue
//   node scripts/issue-client-api-key.mjs --revoke <key-id>
//
//   # list what exists
//   node scripts/issue-client-api-key.mjs --list

import 'dotenv/config';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment.');
  process.exit(1);
}
const sb = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (flag) => process.argv.includes(flag);

async function list() {
  const { data, error } = await sb
    .from('client_api_keys')
    .select('id, name, key_prefix, scopes, created_at, last_used_at, revoked_at, clients(slug)')
    .order('created_at');
  if (error) throw error;
  for (const k of data || []) {
    const state = k.revoked_at ? `REVOKED ${k.revoked_at}` : 'active';
    console.log(
      `${k.id}  ${(k.clients?.slug || '?').padEnd(24)} ${k.key_prefix.padEnd(14)} ` +
      `[${(k.scopes || []).join(',')}]  ${state}  last_used=${k.last_used_at || 'never'}`
    );
    console.log(`    ${k.name}`);
  }
  if (!data?.length) console.log('(no keys issued)');
}

async function revoke(id) {
  const { data, error } = await sb
    .from('client_api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id).select('id, name').single();
  if (error) throw error;
  console.log(`Revoked ${data.id} (${data.name}).`);
}

async function issue() {
  const slug = arg('--slug');
  const name = arg('--name');
  if (!slug || !name) {
    console.error('--slug and --name are required. See the header for usage.');
    process.exit(1);
  }
  const scopes = (arg('--scopes', 'leads:write')).split(',').map(s => s.trim()).filter(Boolean);
  // Human-readable prefix so an operator can tell keys apart in the
  // table (and in Vercel's env list) without ever seeing the secret.
  const label = (arg('--prefix') || slug).replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();

  const { data: client, error: cErr } = await sb
    .from('clients').select('id, name, slug').eq('slug', slug).single();
  if (cErr || !client) {
    console.error(`No clients row with slug "${slug}".`);
    process.exit(1);
  }

  // 32 random bytes → 43 base64url chars. base64url keeps the key safe
  // to paste into an Authorization header and a Vercel env var.
  const rawKey = `${label}_${crypto.randomBytes(32).toString('base64url')}`;
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const keyPrefix = rawKey.slice(0, label.length + 8);

  const { data, error } = await sb.from('client_api_keys').insert({
    client_id: client.id,
    name,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    scopes
  }).select('id, key_prefix, scopes, created_at').single();
  if (error) throw error;

  console.log('');
  console.log(`Issued key for ${client.name} (${client.slug})`);
  console.log(`  id       ${data.id}`);
  console.log(`  prefix   ${data.key_prefix}`);
  console.log(`  scopes   ${data.scopes.join(', ')}`);
  console.log('');
  console.log('  RAW KEY (shown once — copy it now):');
  console.log('');
  console.log(`  ${rawKey}`);
  console.log('');
  console.log('  Only the sha256 hash was stored. Re-running this does NOT recover it.');
  console.log('');
}

const run = has('--list') ? list()
  : has('--revoke') ? revoke(arg('--revoke'))
  : issue();

run.catch((e) => { console.error(e.message || e); process.exit(1); });
