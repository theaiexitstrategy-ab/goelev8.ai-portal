#!/usr/bin/env node
// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot: upload the Dance Is A Sport + Locs & Wellness logos to
// Supabase Storage and wire them onto the corresponding clients rows +
// client_assets pointers.
//
// Reads the two PNG files from Aaron's Desktop (the paths below), so
// this script is portable to whichever machine has those files at
// those paths. If either file is missing the script skips that logo
// and continues with the other.
//
// Run once:
//   PowerShell:
//     $env:SUPABASE_URL="https://<ref>.supabase.co"
//     $env:SUPABASE_SERVICE_ROLE_KEY="eyJhbG..."
//     node scripts/upload-logos.mjs
//   Bash / macOS:
//     SUPABASE_URL=https://<ref>.supabase.co \
//     SUPABASE_SERVICE_ROLE_KEY=eyJhbG... \
//     node scripts/upload-logos.mjs
//
// Idempotent — re-running just overwrites the existing file (upsert:
// true) and refreshes logo_url.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY');
  console.error('   Both are in the portal repo\'s Vercel env vars, or in .env.local.');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const HOME = os.homedir();
const LOGOS = [
  {
    slug:      'danceisasport',
    localPath: path.join(HOME, 'OneDrive', 'Desktop', 'Dance Is A Sport', 'dias-logo.png'),
    bucketKey: 'danceisasport/logo.png',
    mime:      'image/png',
  },
  {
    slug:      'locs-and-wellness',
    localPath: path.join(HOME, 'OneDrive', 'Desktop', 'Locs and Wellness', 'lawco-logo.png'),
    bucketKey: 'locs-and-wellness/logo.png',
    mime:      'image/png',
  },
  {
    slug:      'freeflow-fitness-stl',
    localPath: path.join(HOME, 'OneDrive', 'Desktop', 'Free Flow Fitness', 'tiff free flow logo.png'),
    bucketKey: 'freeflow-fitness-stl/logo.png',
    mime:      'image/png',
  },
];

const BUCKET = 'client-assets';

// Ensure the bucket exists (public so <img src=…> works with no proxy).
// Idempotent — createBucket returns "already exists" on a re-run.
async function ensureBucket() {
  const { error } = await sb.storage.createBucket(BUCKET, { public: true });
  if (error && !/already exists/i.test(error.message || '')) {
    throw new Error('createBucket ' + BUCKET + ' failed: ' + error.message);
  }
}

async function uploadOne({ slug, localPath, bucketKey, mime }) {
  console.log(`\n→ ${slug}`);
  if (!existsSync(localPath)) {
    console.log(`  ⚠ file not found on this machine: ${localPath}`);
    console.log(`  skipping.`);
    return;
  }
  const bytes = readFileSync(localPath);
  console.log(`  read ${bytes.length.toLocaleString()} bytes from ${localPath}`);

  // Upload (upsert:true so re-runs overwrite).
  const { error: upErr } = await sb.storage
    .from(BUCKET)
    .upload(bucketKey, bytes, { contentType: mime, upsert: true });
  if (upErr) throw new Error('upload failed: ' + upErr.message);
  console.log(`  ✓ uploaded to ${BUCKET}/${bucketKey}`);

  // Get public URL.
  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(bucketKey);
  const url = pub?.publicUrl;
  if (!url) throw new Error('could not resolve public URL');
  console.log(`  public URL: ${url}`);

  // Look up the clients row.
  const { data: client } = await sb.from('clients')
    .select('id').eq('slug', slug).maybeSingle();
  if (!client) {
    console.log(`  ⚠ no clients row for slug='${slug}' — logo uploaded but not wired.`);
    console.log(`  Run the seed action (or ensureDefaultClients) then re-run this script.`);
    return;
  }

  // Update clients.logo_url. This is what the SPA sidebar reads.
  const { error: updErr } = await sb.from('clients')
    .update({ logo_url: url }).eq('id', client.id);
  if (updErr) console.log(`  ⚠ clients.logo_url update failed: ${updErr.message}`);
  else       console.log(`  ✓ clients.logo_url set on ${slug}`);

  // Upsert client_assets logo pointer. Tolerant of a missing table
  // (older schemas where the provisioning migrations haven't landed).
  try {
    const { data: existingLogo } = await sb.from('client_assets')
      .select('id').eq('client_id', client.id).eq('label', 'logo').maybeSingle();
    const row = {
      client_id:     client.id,
      label:         'logo',
      page_position: 'header',
      file_url:      url,
      file_path:     bucketKey,
      mime_type:     mime,
      rank:          0,
    };
    if (existingLogo) {
      await sb.from('client_assets').update(row).eq('id', existingLogo.id);
      console.log(`  ✓ client_assets logo row updated`);
    } else {
      await sb.from('client_assets').insert(row);
      console.log(`  ✓ client_assets logo row inserted`);
    }
  } catch (e) {
    console.log(`  ⚠ client_assets step skipped: ${e?.message || e}`);
  }
}

(async () => {
  console.log('Uploading Dance Is A Sport + Locs & Wellness logos → Supabase Storage');
  await ensureBucket();
  for (const logo of LOGOS) {
    try { await uploadOne(logo); }
    catch (e) { console.error(`  ✗ ${logo.slug} failed: ${e.message}`); }
  }
  console.log('\nDone. Hard-refresh the portal and impersonate each tenant to see the logo.');
})();
