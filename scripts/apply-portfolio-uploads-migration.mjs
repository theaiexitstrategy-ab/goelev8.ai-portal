#!/usr/bin/env node
// One-shot: apply migration 0037 (direct-upload support) via Supabase
// Management API.

import 'dotenv/config';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || process.env.SUPABASE_MANAGEMENT_TOKEN;
let REF = process.env.SUPABASE_PROJECT_REF;
if (!REF && process.env.SUPABASE_URL) {
  const m = process.env.SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (m) REF = m[1];
}
if (!TOKEN || !REF) {
  console.error('Missing SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF');
  process.exit(1);
}
const sql = readFileSync('supabase/migrations/0037_portfolio_direct_uploads.sql', 'utf8');
console.log(`Applying 0037 to project ${REF}…`);
const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql })
});
const text = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}:`, text); process.exit(1); }
console.log('✓ Applied.', text.slice(0, 100));
