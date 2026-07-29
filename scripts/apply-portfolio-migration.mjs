#!/usr/bin/env node
// One-shot: apply migration 0036 directly against prod Supabase via
// the Management API (same channel /api/admin?action=ensure-schema
// uses). Idempotent — safe to re-run.
//
// Requires SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (or falls back
// to reading SUPABASE_URL to extract the project ref).

import 'dotenv/config';
import { readFileSync } from 'node:fs';

const SUPABASE_ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN
  || process.env.SUPABASE_MANAGEMENT_TOKEN;
let SUPABASE_PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
if (!SUPABASE_PROJECT_REF && process.env.SUPABASE_URL) {
  const m = process.env.SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (m) SUPABASE_PROJECT_REF = m[1];
}
if (!SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
  console.error('❌ Need SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF (or SUPABASE_URL)');
  process.exit(1);
}

const sql = readFileSync(
  'supabase/migrations/0036_client_portfolio_videos.sql',
  'utf8'
);

// Add the two KB-specific UPDATEs that live in applyPendingMigrations
// (they belong here too since we're applying via API directly).
const extras = `
-- Alias so storefronts still deployed with the old slug keep working.
UPDATE public.clients
  SET slug_aliases = ARRAY['konquered-kocktails']
 WHERE slug = 'konquered-balance'
   AND NOT (slug_aliases @> ARRAY['konquered-kocktails']::text[]);

-- Add 'portfolio' to konquered-balance portal_tabs (9 tabs).
UPDATE public.clients
  SET portal_tabs = '["overview","leads","experience_bookings","experience_availability","merch","portfolio","messaging","analytics","settings"]'::jsonb
 WHERE slug = 'konquered-balance'
   AND portal_tabs IS DISTINCT FROM
       '["overview","leads","experience_bookings","experience_availability","merch","portfolio","messaging","analytics","settings"]'::jsonb;
`;

const fullSql = sql + '\n' + extras;

console.log(`Applying to project ${SUPABASE_PROJECT_REF}…`);
const url = `https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${SUPABASE_ACCESS_TOKEN}`,
    'Content-Type':  'application/json'
  },
  body: JSON.stringify({ query: fullSql })
});
const text = await res.text();
if (!res.ok) {
  console.error(`❌ HTTP ${res.status}:`, text);
  process.exit(1);
}
console.log('✅ Applied. Response:', text.slice(0, 200));
