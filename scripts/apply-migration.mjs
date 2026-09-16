#!/usr/bin/env node
// Apply one or more migration files to the live project via the Supabase
// Management API — the same mechanism scripts/apply-0038-0039.mjs used,
// generalised so the next migration doesn't need its own one-off script.
//
// Needs SUPABASE_ACCESS_TOKEN (a personal access token from
// https://supabase.com/dashboard/account/tokens) plus SUPABASE_PROJECT_REF
// or SUPABASE_URL in .env.
//
// Usage:
//   node scripts/apply-migration.mjs 0045 0046
//   node scripts/apply-migration.mjs supabase/migrations/0046_*.sql
//   node scripts/apply-migration.mjs --check 0045 0046   # verify only
//
// Migrations in this repo are written to be idempotent (IF NOT EXISTS /
// DROP ... IF EXISTS), so re-running one that already landed is a no-op.

import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = 'supabase/migrations';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
let REF = process.env.SUPABASE_PROJECT_REF;
if (!REF && process.env.SUPABASE_URL) {
  const m = process.env.SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (m) REF = m[1];
}
if (!TOKEN || !REF) {
  console.error('Missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF / SUPABASE_URL.');
  process.exit(1);
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const targets = args.filter((a) => a !== '--check');
if (!targets.length) {
  console.error('Name at least one migration (a number like 0046, or a path).');
  process.exit(1);
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { return []; }
}

// Accept a bare migration number and find the file it names, so callers
// don't have to type (or glob) the full descriptive filename.
function resolveMigration(target) {
  if (target.endsWith('.sql')) return target;
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith(target + '_'));
  if (!files.length) throw new Error(`No migration matching "${target}" in ${MIGRATIONS_DIR}`);
  if (files.length > 1) throw new Error(`Ambiguous: ${files.join(', ')}`);
  return path.join(MIGRATIONS_DIR, files[0]);
}

console.log(`project ${REF}\n`);
let failed = 0;
for (const target of targets) {
  let file;
  try { file = resolveMigration(target); }
  catch (e) { console.error('✗ ' + e.message); failed++; continue; }

  if (checkOnly) { console.log('would apply ' + file); continue; }

  try {
    await sql(readFileSync(file, 'utf8'));
    console.log('✓ applied ' + file);
  } catch (e) {
    console.error('✗ ' + file + '\n  ' + e.message);
    failed++;
  }
}

if (!checkOnly && !failed) {
  // Post-check for the two migrations this script was written to carry.
  // Harmless when they weren't part of this run — it just reports state.
  const trigger = await sql(
    "select 1 from pg_trigger where tgname='client_portfolio_videos_cap' and not tgisinternal");
  const softDel = await sql(
    "select 1 from information_schema.columns " +
    "where table_name='experience_bookings' and column_name='deleted_at'");
  console.log('\nstate:');
  console.log('  portfolio 5-video cap trigger : ' + (trigger.length ? 'STILL PRESENT' : 'gone ✓'));
  console.log('  experience_bookings.deleted_at: ' + (softDel.length ? 'present ✓' : 'MISSING'));
}

process.exit(failed ? 1 : 0);
