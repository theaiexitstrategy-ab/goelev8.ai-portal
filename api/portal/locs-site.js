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

// Canonical DEFAULTS mirrored from the source repo's
// lib/marketing/content.ts. The live homepage renders each section
// as: getSiteContent() → shallow-merge saved row OVER these defaults.
// The editor must prefill from the SAME merged shape or Leslie sees
// blank forms for sections she hasn't touched (which look "missing"
// even though the live site shows the default copy). Update HERE if
// content.ts DEFAULTS change on the source.
const BOOKING_URL = 'https://lawco.glossgenius.com';
const LOCS_SITE_DEFAULTS = {
  hero: {
    headline: 'Cultivating healthy scalp, hair, and locs — for each individual.',
    tagline:  'Every loc tells a story. My job is to honor yours.',
    cta:      'Book a consultation',
    ctaUrl:   BOOKING_URL,
    image:    ''
  },
  quiz: {
    intro: 'A few quick questions to point you toward the right first step.',
    questions: [
      { q: 'Where are you in your loc journey?', options: [
        { label: 'Starting fresh', key: 'traditional' },
        { label: 'Maintaining existing locs', key: 'traditional' },
        { label: 'Ready for a new style', key: 'styling' },
        { label: 'Dealing with scalp concerns', key: 'scalp' },
      ]},
      { q: 'What matters most right now?', options: [
        { label: 'Scalp health & relief', key: 'scalp' },
        { label: 'A precise, versatile look', key: 'sisterlocks' },
        { label: 'Bold, statement locs', key: 'large' },
        { label: 'A fresh style for an event', key: 'styling' },
      ]},
      { q: 'Your ideal loc size?', options: [
        { label: 'Micro / Sisterlocks', key: 'sisterlocks' },
        { label: 'Traditional', key: 'traditional' },
        { label: 'Large / Wicks', key: 'large' },
        { label: 'Not sure yet', key: 'traditional' },
      ]},
    ],
    results: {
      sisterlocks: { title: 'Sisterlocks / Microlocs',  body: 'Precise, versatile micro-locs look like a beautiful fit. Let’s talk sizing and a maintenance rhythm that keeps them healthy.' },
      traditional: { title: 'Traditional Locs',          body: 'Classic locs with palm rolling or interlocking suit you. We’ll build a plan for strong, healthy growth.' },
      large:       { title: 'Large Locs / Wicks',        body: 'Bold, statement locs are calling. Let’s shape and groom them to suit your look and lifestyle.' },
      scalp:       { title: 'Scalp Wellness Consultation', body: 'Let’s start at the scalp — an assessment, gentle cleansing, and a wellness plan so your locs thrive from the root.' },
      styling:     { title: 'Loc Styling',               body: 'From everyday looks to premium event styles — let’s find the perfect one for your moment.' },
    }
  },
  method: {
    title: 'The Locs & Wellness Method',
    intro: 'A calm, considered path from first conversation to lasting home care.',
    steps: [
      { n: '01', title: 'Consultation',                 body: 'We start by listening — your history, your scalp, your goals for your locs.' },
      { n: '02', title: 'Personalized recommendations', body: 'A plan built around your hair type, lifestyle, and where you want to go.' },
      { n: '03', title: 'Professional service',         body: 'Skilled, unhurried hands-on care in a peaceful studio setting.' },
      { n: '04', title: 'Home care guidance',           body: 'Simple, sustainable routines so your progress continues between visits.' },
    ]
  },
  services: [
    { title: 'Sisterlocks / Microlocs', body: 'Precise, versatile micro-sized locs installed and maintained with care.', bookingUrl: BOOKING_URL, image: '' },
    { title: 'Traditional Locs',        body: 'Palm rolling, interlocking, and crochet methods for classic, healthy locs.', bookingUrl: BOOKING_URL, image: '' },
    { title: 'Large Locs / Wicks',      body: 'Bold, statement locs and wicks shaped and groomed to suit you.',            bookingUrl: BOOKING_URL, image: '' },
    { title: 'Loc Styling',             body: 'From simple everyday looks to premium styles for your special moments.',   bookingUrl: BOOKING_URL, image: '' },
  ],
  scalpWellness: {
    title: 'Scalp Wellness',
    intro: 'The clinical, wellness-focused side of loc care — because healthy locs start at the scalp.',
    pills: ['Scalp assessments', 'Cleansing', 'Exfoliation', 'Hydration', 'Wellness treatments']
  },
  products: {
    title: 'Products & Home Care',
    intro: 'A short, honest shelf of what I actually reach for — expanding soon.',
    items: [
      { name: 'Hydrating Scalp Mist',  body: 'Lightweight daily moisture for a calm, balanced scalp.',  image: '' },
      { name: 'Gentle Cleansing Wash', body: 'Residue-free clarifying wash that respects your locs.',   image: '' },
      { name: 'Sealing Loc Oil',       body: 'A finishing oil to seal in moisture and add soft shine.', image: '' },
    ]
  },
  ebooks: {
    title: 'Learn with me',
    intro: 'Guides to help you care for your scalp and locs between visits.',
    items: [
      { title: 'The Healthy Scalp Starter', body: 'The fundamentals of a balanced, thriving scalp.', buttonUrl: '', cover: '' },
      { title: 'Loc Maintenance at Home',   body: 'A simple weekly rhythm to keep your locs strong.', buttonUrl: '', cover: '' },
    ]
  },
  about: {
    title: 'Meet Leslie',
    bio: [
      'The Locs & Wellness Co. was born from a simple belief: every loc tells a story, and my job is to honor yours.',
      'I care for scalp, hair, and locs as one connected system — blending skilled technique with genuine wellness, so you leave feeling seen, not rushed.'
    ],
    certifications: ['Certified Loctician', 'Scalp & Trichology Care (placeholder)', 'Sisterlocks-trained (placeholder)'],
    headshot: ''
  },
  testimonials: {
    showBeforeAfter: false,
    items: [
      { quote: 'Placeholder quote — carried from the live site; Leslie can edit or replace.', name: 'Tanya M.',   service: 'Traditional Retwist',    beforeImage: '', afterImage: '' },
      { quote: 'Placeholder quote — carried from the live site; Leslie can edit or replace.', name: 'Darius K.',  service: 'Large Locs Grooming',    beforeImage: '', afterImage: '' },
      { quote: 'Placeholder quote — carried from the live site; Leslie can edit or replace.', name: 'Janelle R.', service: 'Interlocking',           beforeImage: '', afterImage: '' },
    ]
  },
  finalCta: {
    headline: 'Ready to begin your loc wellness journey?',
    subtext:  'Book a consultation and let’s build a plan for your healthiest scalp, hair, and locs.',
    cta:      'Schedule your consultation',
    ctaUrl:   BOOKING_URL
  }
};

// Mirrors lib/marketing/site.ts mergeSection() rules:
//   - saved null → default
//   - default is an Array → saved (or default) wholesale (no
//     property-merge; the editor submits the full array)
//   - else → shallow spread: { ...default, ...saved }
function mergeSection(key, saved) {
  const def = LOCS_SITE_DEFAULTS[key];
  if (saved == null || typeof saved !== 'object' || Array.isArray(saved) || Array.isArray(def)) {
    return saved == null ? def : saved;
  }
  return { ...def, ...saved };
}

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
  // Which sections have an actual saved row (vs. showing defaults).
  // Editor uses this to render "Saved · <ts>" vs "Currently defaults
  // — save to persist edits" per section.
  const savedKeys = new Set((data || []).map((r) => r.key));
  const savedByKey = {};
  for (const r of data || []) savedByKey[r.key] = r.data;
  // Merge every section's saved row over its default — same rules as
  // lib/marketing/site.ts on the source. Editor prefills from this so
  // Leslie sees what's on the live site right now, not empty forms.
  const byKey = {};
  for (const key of Object.keys(LOCS_SITE_DEFAULTS)) {
    byKey[key] = mergeSection(key, savedByKey[key]);
  }
  // Public URL prefix for the locs-site bucket — the SPA prepends this
  // to any bare storage path stored on a media field to render a live
  // thumbnail. Matches resolveImage() in the source lib/marketing/
  // image.ts: bare path → prefix, full https URL → use as-is.
  const { data: pub } = supabaseAdmin.storage.from(SITE_BUCKET).getPublicUrl('');
  const siteBucketPublicPrefix = (pub?.publicUrl || '').replace(/\/$/, '') + '/';
  return res.status(200).json({
    rows: data || [],
    byKey,                            // merged: defaults + saved
    savedKeys: Array.from(savedKeys), // for the "Currently defaults" indicator
    siteBucketPublicPrefix
  });
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
