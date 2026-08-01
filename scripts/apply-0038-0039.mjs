#!/usr/bin/env node
// One-shot: apply migrations 0038 (sms_credits RLS) + 0039 (reviews
// tenant_alert_sent_at column) via Supabase Management API.

import 'dotenv/config';
import { readFileSync } from 'node:fs';

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
let REF = process.env.SUPABASE_PROJECT_REF;
if (!REF && process.env.SUPABASE_URL) {
  const m = process.env.SUPABASE_URL.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
  if (m) REF = m[1];
}
if (!TOKEN || !REF) { console.error('missing SUPABASE_ACCESS_TOKEN or SUPABASE_PROJECT_REF/URL'); process.exit(1); }

async function apply(path) {
  const sql = readFileSync(path, 'utf8');
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql })
  });
  const text = await res.text();
  console.log(path + ': HTTP ' + res.status + ' ' + text.slice(0, 200));
  return res.ok;
}

const ok1 = await apply('supabase/migrations/0038_sms_credits_rls.sql');
const ok2 = await apply('supabase/migrations/0039_reviews_tenant_alert.sql');
process.exit(ok1 && ok2 ? 0 : 1);
