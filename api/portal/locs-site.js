// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Backing endpoint for Leslie's "Website" (edit my site) tab in the
// Locs & Wellness Co. tenant portal. Contract mirrors the source repo:
//   c:\Users\aaron\OneDrive\Desktop\Locs and Wellness\locsandwellness
// The live homepage reads locs_site_content.data per section and merges
// it OVER the code DEFAULTS in lib/marketing/content.ts, so a Save here
// updates the live site on the next request.
//
// Actions:
//   GET  ?action=list       → all locs_site_content rows for the tenant
//   POST ?action=save       body { key, data, updated_by }  → upsert
//   POST ?action=upload-media  body { path, data_url, mime }
//     → stores in the public locs-site bucket at that path, returns
//       both the path (what Leslie's field stores) and the public URL
//       (for the editor's live thumbnail).
//
// SECURITY MODEL — identical to wellness-clients.js:
//   1. Endpoint verifies the caller is authenticated.
//   2. Endpoint verifies the caller is EITHER master admin OR their
//      tenant slug is 'locs-and-wellness'.
//   3. Once gated, queries locs_site_content + writes the locs-site
//      bucket via supabaseAdmin (service role, bypasses the
//      locs_is_admin() RLS which we can't satisfy from a portal
//      bearer session).
// The service-role key never reaches the browser; the bucket is
// public-read but admin-write per the source migration.

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const TENANT_SLUG = 'locs-and-wellness';
const SITE_BUCKET = 'locs-site';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — hero videos can be
                                            // larger than typical
                                            // MMS/logo uploads.

// Section keys allowed for save — mirrors SECTION_KEYS in content.ts.
// Rejecting unknown keys keeps the CMS store predictable if a client
// mistake sends a typo'd key.
const ALLOWED_SECTION_KEYS = new Set([
  'hero', 'quiz', 'method', 'services', 'scalpWellness',
  'products', 'ebooks', 'about', 'testimonials', 'finalCta'
]);

async function assertLocsAccess(ctx) {
  if (ctx.isAdmin) return { allowed: true };
  if (!ctx.clientId) return { allowed: false, reason: 'no_tenant_context' };
  const { data: c } = await supabaseAdmin
    .from('clients').select('slug').eq('id', ctx.clientId).maybeSingle();
  if (c?.slug === TENANT_SLUG) return { allowed: true };
  return { allowed: false, reason: 'tenant_not_locs' };
}

async function listContent(res) {
  const { data, error } = await supabaseAdmin
    .from('locs_site_content')
    .select('key, data, updated_at, updated_by');
  if (error) return res.status(500).json({ error: error.message });
  const byKey = {};
  for (const r of data || []) byKey[r.key] = r.data;
  // Public URL prefix for the locs-site bucket — the SPA prepends this
  // to any bare storage path stored on a media field to render a live
  // thumbnail. Matches resolveImage() in the source lib/marketing/
  // image.ts: bare path → prefix, full https URL → use as-is.
  const { data: pub } = supabaseAdmin.storage.from(SITE_BUCKET).getPublicUrl('');
  const siteBucketPublicPrefix = (pub?.publicUrl || '').replace(/\/$/, '') + '/';
  return res.status(200).json({ rows: data || [], byKey, siteBucketPublicPrefix });
}

async function saveSection(req, res, ctx) {
  const body = await readJson(req);
  const key = String(body?.key || '').trim();
  const data = body?.data;
  if (!key)                return res.status(400).json({ error: 'key_required' });
  if (!ALLOWED_SECTION_KEYS.has(key)) {
    return res.status(400).json({ error: 'unknown_section_key', key });
  }
  if (data == null || typeof data !== 'object') {
    return res.status(400).json({ error: 'data_must_be_object_or_array' });
  }
  const updated_by = ctx?.user?.email || 'admin';
  // Upsert on primary key. Submits the WHOLE section object — the
  // homepage merge is shallow, arrays replace wholesale.
  const { error } = await supabaseAdmin
    .from('locs_site_content')
    .upsert({ key, data, updated_by, updated_at: new Date().toISOString() },
            { onConflict: 'key' });
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, key, updated_by, updated_at: new Date().toISOString() });
}

// Upload one image or video to the locs-site public bucket. Accepts a
// base64 data URI in the body — matches the merch + MMS upload pattern
// so the SPA doesn't need multipart/form-data. Returns the storage
// path (which is what Leslie's section field stores) AND the resolved
// public URL for the editor's live thumbnail.
async function uploadMedia(req, res) {
  const body = await readJson(req);
  const rawPath = String(body?.path || '').trim().replace(/^\/+/, '');
  const dataUrl = String(body?.data_url || '');
  if (!rawPath)             return res.status(400).json({ error: 'path_required' });
  if (!dataUrl.startsWith('data:')) {
    return res.status(400).json({ error: 'data_url_required' });
  }
  const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid_data_url' });
  const mime = m[1];
  const b64  = m[2];
  const sizeBytes = Math.floor(b64.length * 0.75);
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'file_too_large', max_bytes: MAX_UPLOAD_BYTES });
  }
  const isImage = /^image\//i.test(mime);
  const isVideo = /^video\//i.test(mime);
  if (!isImage && !isVideo) return res.status(400).json({ error: 'only_image_or_video_allowed' });
  const buf = Buffer.from(b64, 'base64');

  let upErr;
  {
    const r = await supabaseAdmin.storage.from(SITE_BUCKET)
      .upload(rawPath, buf, { contentType: mime, upsert: true });
    upErr = r.error;
  }
  if (upErr && /Bucket not found/i.test(upErr.message || '')) {
    // Safety net if the site-bucket migration hasn't been applied
    // here yet. Idempotent — createBucket returns "already exists"
    // on a re-run.
    const created = await supabaseAdmin.storage.createBucket(SITE_BUCKET, { public: true });
    if (created.error && !/already exists/i.test(created.error.message || '')) {
      return res.status(500).json({ error: 'bucket_create_failed: ' + created.error.message });
    }
    const retry = await supabaseAdmin.storage.from(SITE_BUCKET)
      .upload(rawPath, buf, { contentType: mime, upsert: true });
    upErr = retry.error;
  }
  if (upErr) return res.status(500).json({ error: 'upload_failed: ' + upErr.message });
  const { data: pub } = supabaseAdmin.storage.from(SITE_BUCKET).getPublicUrl(rawPath);
  return res.status(200).json({
    ok: true,
    path: rawPath,           // Leslie's field stores THIS
    publicUrl: pub?.publicUrl || null,
    mime, is_video: isVideo, size_bytes: sizeBytes
  });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const gate = await assertLocsAccess(ctx);
  if (!gate.allowed) return res.status(403).json({ error: 'forbidden', reason: gate.reason });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action') || 'list';

  if (action === 'list')         return await listContent(res);
  if (action === 'save')         return await saveSection(req, res, ctx);
  if (action === 'upload-media') return await uploadMedia(req, res);
  return res.status(400).json({ error: 'unknown_action' });
}
