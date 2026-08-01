// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Tenant-authed CRUD for guest reviews. Powers the portal Reviews tab
// so Stephen (or any future tenant with 'reviews' in portal_tabs) can
// review, approve, unpublish, and delete reviews submitted through
// their public /reviews capture page.
//
// Public capture writes rows via anon PostgREST insert directly to
// public.reviews with published=false. Public read is gated by RLS
// to published=true rows only. This endpoint uses supabaseAdmin
// (service role, bypasses RLS) but still gates access with
// admin-OR-tenant-membership auth.
//
// Routes:
//   GET    ?client=<slug>&status=all|published|pending  → { reviews, counts }
//   POST   ?action=approve&id=<uuid>                   → { ok, review }
//   POST   ?action=unpublish&id=<uuid>                 → { ok, review }
//   DELETE ?id=<uuid>                                  → { ok, photos }
//     Purges photos[] from the event-photos bucket best-effort.
//
// SECURITY: never exposes `email` outside this authed surface. The
// operator sees email + contact_ok; nothing about this file leaks
// to anon or the public path.

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireUser } from '../../lib/auth.js';

const PHOTO_BUCKET = 'event-photos';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function resolveClientId(ctx, url) {
  if (ctx.isAdmin) {
    const slugOrId = url.searchParams.get('client');
    if (!slugOrId) return { error: 'client_slug_required_for_admin' };
    if (/^[0-9a-f-]{36}$/i.test(slugOrId)) return { clientId: slugOrId };
    const { data } = await supabaseAdmin.from('clients').select('id').eq('slug', slugOrId).maybeSingle();
    if (!data) return { error: 'client_not_found' };
    return { clientId: data.id };
  }
  if (!ctx.clientId) return { error: 'no_tenant_context' };
  return { clientId: ctx.clientId };
}

async function handleList(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });

  const status = url.searchParams.get('status') || 'all';

  let query = supabaseAdmin
    .from('reviews')
    .select('*')
    .eq('client_id', r.clientId)
    .order('created_at', { ascending: false });
  if (status === 'published') query = query.eq('published', true);
  if (status === 'pending')   query = query.eq('published', false);

  const { data, error } = await query;
  if (error) {
    if (/relation .*reviews.* does not exist/i.test(error.message || '')) {
      return res.status(200).json({ reviews: [], counts: { total: 0, published: 0, pending: 0 }, setup_required: true });
    }
    return res.status(500).json({ error: error.message });
  }

  // Compute counts across ALL statuses for the header, independent of
  // the current filter — one lightweight per-status count so the tab
  // shows "3 pending · 12 published · 15 total" even when filtered.
  const { data: countRows } = await supabaseAdmin
    .from('reviews').select('published').eq('client_id', r.clientId);
  const total = (countRows || []).length;
  const published = (countRows || []).filter(x => x.published).length;
  const counts = { total, published, pending: total - published };

  return res.status(200).json({ reviews: data || [], counts });
}

async function handleApproveOrUnpublish(req, res, mode) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.searchParams.get('id');
  if (!id) return res.status(400).json({ error: 'id_required' });

  const { data: existing } = await supabaseAdmin
    .from('reviews').select('client_id, published, published_at').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && ctx.clientId !== existing.client_id) return res.status(403).json({ error: 'forbidden' });

  const patch = mode === 'approve'
    ? { published: true,  published_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    // Explicitly CLEAR published_at (per project constraint). Not just
    // flipping the boolean — the timestamp must go too.
    : { published: false, published_at: null,                     updated_at: new Date().toISOString() };
  const { data, error } = await supabaseAdmin
    .from('reviews').update(patch).eq('id', id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, review: data });
}

async function handleDelete(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.searchParams.get('id');
  if (!id) return res.status(400).json({ error: 'id_required' });

  const { data: existing } = await supabaseAdmin
    .from('reviews').select('client_id, photos').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && ctx.clientId !== existing.client_id) return res.status(403).json({ error: 'forbidden' });

  // Purge photos first so a delete failure on the DB doesn't leave
  // orphans; a purge failure alone doesn't stop the DB delete since
  // the operator's primary intent is "make it go away".
  const photoResult = { requested: 0, removed: 0, failed: 0 };
  const photoPaths = Array.isArray(existing.photos)
    ? existing.photos.filter(p => typeof p === 'string' && p.trim())
    : [];
  if (photoPaths.length) {
    photoResult.requested = photoPaths.length;
    const { error: rmErr } = await supabaseAdmin.storage.from(PHOTO_BUCKET).remove(photoPaths);
    if (rmErr) {
      photoResult.failed = photoPaths.length;
      console.warn('[reviews] photo purge failed:', rmErr.message);
    } else {
      photoResult.removed = photoPaths.length;
    }
  }

  const { error } = await supabaseAdmin.from('reviews').delete().eq('id', id);
  if (error) return res.status(500).json({ error: 'delete_failed', message: error.message });
  return res.status(200).json({ ok: true, photos: photoResult });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return await handleList(req, res);
  if (req.method === 'POST') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get('action');
    if (action === 'approve')   return await handleApproveOrUnpublish(req, res, 'approve');
    if (action === 'unpublish') return await handleApproveOrUnpublish(req, res, 'unpublish');
    return res.status(400).json({ error: 'unknown_action', action });
  }
  if (req.method === 'DELETE') return await handleDelete(req, res);
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
