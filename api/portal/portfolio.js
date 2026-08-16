// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Tenant-authed CRUD for client_portfolio_videos. Powers the portal
// Portfolio tab. Auth mirrors /api/portal/experience-availability:
// master admin OR the tenant owner/admin (via client_users).
//
// Routes:
//   GET    /api/portal/portfolio                    → { videos, cap: 5 }
//     Returns ALL rows (including inactive) so the editor can show
//     dimmed rows too. Admin can pass ?client=<slug|id>.
//
//   POST   /api/portal/portfolio?action=upsert      body: video row
//   POST   /api/portal/portfolio?action=reorder     body: { order: [id...] }
//   DELETE /api/portal/portfolio?id=<uuid>
//
// upsert validates Mux playback_id via lib/mux-validate.js before
// writing — HEAD-checks both stream.mux.com and image.mux.com so a
// signed / bogus / renamed ID can't quietly reach a live page.
//
// 5-active-video cap is enforced by the DB trigger
// enforce_portfolio_5_video_cap(). This endpoint just translates the
// trigger's 'portfolio_5_video_cap_exceeded' EXCEPTION into a 409
// with the same error string.

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireUser } from '../../lib/auth.js';
import { normalizePlaybackId, validatePlaybackIdLive } from '../../lib/mux-validate.js';
import { createDirectUpload, resolveUploadToAsset, deleteAsset } from '../../lib/mux-api.js';

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
    // Precedence: ?client=<slug|uuid> URL param → x-admin-as-client
    // header (arrives as ctx.clientId) → error. See api/portal/
    // reviews.js resolveClientId for the shared reasoning.
    const slugOrId = url.searchParams.get('client');
    if (slugOrId && slugOrId !== 'undefined' && slugOrId !== 'null') {
      if (/^[0-9a-f-]{36}$/i.test(slugOrId)) return { clientId: slugOrId };
      const { data } = await supabaseAdmin.from('clients').select('id').eq('slug', slugOrId).maybeSingle();
      if (!data) return { error: 'client_not_found', slug: slugOrId };
      return { clientId: data.id };
    }
    if (ctx.clientId && /^[0-9a-f-]{36}$/i.test(String(ctx.clientId))) {
      return { clientId: ctx.clientId };
    }
    return { error: 'client_slug_required_for_admin' };
  }
  if (!ctx.clientId) return { error: 'no_tenant_context' };
  return { clientId: ctx.clientId };
}

// Slugify a title into a stable video_key. Only used when the caller
// doesn't supply one on create; on update we don't touch it.
function slugifyKey(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'video';
}

// Translate a Postgres error into an HTTP status. Cap violations come
// from the trigger as EXCEPTION with message
// 'portfolio_5_video_cap_exceeded'; the client sees a 409 with the
// same error string.
function statusForPgError(err) {
  const msg = String(err?.message || '');
  if (/portfolio_5_video_cap_exceeded/.test(msg)) return { status: 409, error: 'portfolio_5_video_cap_exceeded',
    message: 'You already have 5 active videos. Remove or deactivate one before adding another.' };
  if (/duplicate key value.*client_portfolio_videos_client_key_uniq/i.test(msg)) return { status: 409, error: 'duplicate_video_key',
    message: 'A video with that key already exists on this tenant. Pick a different title.' };
  return { status: 500, error: 'db_error', message: msg };
}

async function handleList(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const { data, error } = await supabaseAdmin
    .from('client_portfolio_videos').select('*')
    .eq('client_id', r.clientId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) {
    if (/relation .*client_portfolio_videos.* does not exist/i.test(error.message || '')) {
      return res.status(200).json({ videos: [], cap: 5, setup_required: true });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ videos: data || [], cap: 5 });
}

async function handleUpsert(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const clientId = r.clientId;

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const title = String(body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  if (title.length > 200) return res.status(400).json({ error: 'title_too_long' });

  const rawPlayback = String(body?.mux_playback_id ?? body?.playback_id ?? '').trim();
  if (!rawPlayback) return res.status(400).json({ error: 'mux_playback_id_required' });
  const normalized = normalizePlaybackId(rawPlayback);
  if (!normalized.ok) {
    return res.status(400).json({
      error: normalized.error,
      message: normalized.message || 'Playback ID could not be parsed. Paste just the ID (44+ chars) from Mux dashboard.'
    });
  }
  // Skip the live Mux HEAD check only when the caller explicitly asks
  // (e.g. seed script has already verified upstream). Default = always
  // validate.
  const skipLive = body?.skip_live_check === true;
  if (!skipLive) {
    const verdict = await validatePlaybackIdLive(normalized.id);
    if (!verdict.ok) {
      return res.status(400).json({
        error: verdict.error || 'mux_validation_failed',
        stage: verdict.stage,
        message: verdict.message,
        parts: verdict.parts
      });
    }
  }
  const playbackId = normalized.id;

  const isEdit = !!body?.id;
  const posterUrl = body?.poster_url ? String(body.poster_url).trim().slice(0, 500) : null;
  if (posterUrl && !/^https?:\/\//i.test(posterUrl)) {
    return res.status(400).json({ error: 'poster_url_must_be_http_or_https' });
  }
  const description = body?.description == null ? null
    : String(body.description).slice(0, 2000);
  const active = body?.is_active === false ? false : true;
  const sortOrder = Number.isFinite(+body?.sort_order) ? Math.floor(+body.sort_order) : null;

  if (isEdit) {
    // Verify ownership + fetch existing sort_order/video_key.
    const { data: existing } = await supabaseAdmin
      .from('client_portfolio_videos').select('id, client_id, video_key, sort_order')
      .eq('id', body.id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!ctx.isAdmin && existing.client_id !== clientId) return res.status(403).json({ error: 'forbidden' });
    const patch = {
      title,
      description,
      mux_playback_id: playbackId,
      poster_url: posterUrl,
      is_active: active
    };
    if (sortOrder != null) patch.sort_order = sortOrder;
    // Only touch video_key if explicitly supplied — usually stable.
    const newKey = body?.video_key ? slugifyKey(body.video_key) : null;
    if (newKey && newKey !== existing.video_key) patch.video_key = newKey;

    const { data, error } = await supabaseAdmin.from('client_portfolio_videos')
      .update(patch).eq('id', body.id).select().single();
    if (error) {
      const t = statusForPgError(error);
      return res.status(t.status).json({ error: t.error, message: t.message });
    }
    return res.status(200).json({ ok: true, video: data });
  }

  // Create. If no sort_order supplied, put it at the end.
  let effectiveSort = sortOrder;
  if (effectiveSort == null) {
    const { data: last } = await supabaseAdmin
      .from('client_portfolio_videos').select('sort_order')
      .eq('client_id', clientId).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    effectiveSort = (last?.sort_order ?? -1) + 1;
  }
  const videoKey = body?.video_key ? slugifyKey(body.video_key) : slugifyKey(title);
  const row = {
    client_id: clientId,
    video_key: videoKey,
    title, description,
    mux_playback_id: playbackId,
    poster_url: posterUrl,
    is_active: active,
    sort_order: effectiveSort
  };
  const { data, error } = await supabaseAdmin.from('client_portfolio_videos')
    .insert(row).select().single();
  if (error) {
    const t = statusForPgError(error);
    return res.status(t.status).json({ error: t.error, message: t.message });
  }
  return res.status(200).json({ ok: true, video: data });
}

async function handleReorder(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const clientId = r.clientId;
  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const order = Array.isArray(body?.order) ? body.order : null;
  if (!order || !order.length) return res.status(400).json({ error: 'order_array_required' });

  // Sanity: every id must belong to this client
  const { data: existing } = await supabaseAdmin
    .from('client_portfolio_videos').select('id, client_id')
    .in('id', order);
  const bad = (existing || []).find(r => r.client_id !== clientId);
  if (bad && !ctx.isAdmin) return res.status(403).json({ error: 'row_not_owned', id: bad.id });

  const results = [];
  for (let i = 0; i < order.length; i++) {
    const { error } = await supabaseAdmin.from('client_portfolio_videos')
      .update({ sort_order: i }).eq('id', order[i]).eq('client_id', clientId);
    if (error) results.push({ id: order[i], error: error.message });
  }
  if (results.length) return res.status(500).json({ error: 'partial_reorder_failure', results });
  return res.status(200).json({ ok: true });
}

// ── Direct upload: start ─────────────────────────────────────────
// Creates a placeholder client_portfolio_videos row (status='uploading',
// playback_id=null) + a Mux Direct Upload URL. Returns the URL to the
// phone; the phone PUTs the file straight to Mux — never through our
// serverless (bypassing Vercel body size limits + timeouts).
async function handleStartUpload(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const clientId = r.clientId;

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const title = String(body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title_required' });
  if (title.length > 200) return res.status(400).json({ error: 'title_too_long' });
  const description = body?.description == null ? null : String(body.description).slice(0, 2000);

  // Provision Mux Direct Upload FIRST — if this fails, we haven't
  // written a broken row to the DB.
  let mux;
  try { mux = await createDirectUpload({
    corsOrigin: req.headers.origin || undefined
  }); }
  catch (e) {
    // Log server-side too. The response carries the message to the
    // operator, but having it in the runtime logs means a failure can be
    // diagnosed after the fact without asking them to reproduce it and
    // read the screen back.
    console.error('[portfolio] mux upload create failed:', e?.message, e?.body ? String(e.body).slice(0, 500) : '');
    return res.status(500).json({
      error: 'mux_upload_create_failed',
      message: e.message,
      mux_status: e.status || null
    });
  }

  // Compute next sort_order (append at end).
  const { data: last } = await supabaseAdmin
    .from('client_portfolio_videos').select('sort_order')
    .eq('client_id', clientId).order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const nextSort = (last?.sort_order ?? -1) + 1;

  // Stable video_key derived from title — used later by /api/external/portfolio.
  const baseKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
  // Suffix with timestamp to avoid a UNIQUE collision on same-title repeats.
  const videoKey = `${baseKey}-${Date.now().toString(36)}`;

  const row = {
    client_id:      clientId,
    video_key:      videoKey,
    title, description,
    mux_upload_id:  mux.upload_id,
    status:         'uploading',
    is_active:      true,     // becomes visible via the public endpoint once playback_id lands
    sort_order:     nextSort
  };
  const { data, error } = await supabaseAdmin.from('client_portfolio_videos')
    .insert(row).select().single();
  if (error) {
    const t = statusForPgError(error);
    return res.status(t.status).json({ error: t.error, message: t.message });
  }
  return res.status(200).json({
    ok: true,
    video: data,
    upload_url: mux.upload_url,
    upload_id:  mux.upload_id,
    cors_origin: mux.cors_origin
  });
}

// ── Direct upload: check status ──────────────────────────────────
// Called by the SPA every few seconds after the phone finishes PUT.
// Walks Mux upload → asset. Updates our row when it flips ready/errored.
// Idempotent; safe to hammer.
async function handleCheckUpload(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.searchParams.get('video_id');
  if (!id) return res.status(400).json({ error: 'video_id_required' });

  const { data: row } = await supabaseAdmin.from('client_portfolio_videos')
    .select('*').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && ctx.clientId !== row.client_id) return res.status(403).json({ error: 'forbidden' });

  // Already terminal — just echo back current state.
  if (row.status === 'ready' || row.status === 'errored') {
    return res.status(200).json({ ok: true, video: row });
  }
  if (!row.mux_upload_id) {
    return res.status(400).json({ error: 'no_upload_id_on_row' });
  }

  let verdict;
  try { verdict = await resolveUploadToAsset(row.mux_upload_id); }
  catch (e) {
    return res.status(502).json({ error: 'mux_check_failed', message: e.message });
  }

  const patch = { };
  if (verdict.stage === 'upload') {
    // Waiting for bytes OR just-arrived-not-yet-processed.
    // 'waiting' = URL issued, no PUT received yet — keep status='uploading'.
    // Anything else Mux reports as terminal upload failure.
    if (['errored', 'cancelled', 'timed_out'].includes(verdict.status)) {
      patch.status = 'errored';
      patch.error_message = verdict.error_message || verdict.status;
    }
  } else if (verdict.stage === 'asset') {
    patch.mux_asset_id = verdict.asset_id;
    if (verdict.asset_status === 'ready' && verdict.playback_id) {
      patch.mux_playback_id  = verdict.playback_id;
      patch.status           = 'ready';
      patch.duration_seconds = verdict.duration_seconds || null;
      patch.error_message    = null;
    } else if (verdict.asset_status === 'errored') {
      patch.status = 'errored';
      patch.error_message = verdict.error_message || 'asset_errored';
    } else {
      // 'preparing' — Mux is encoding
      if (row.status !== 'processing') patch.status = 'processing';
    }
  }

  if (Object.keys(patch).length) {
    patch.updated_at = new Date().toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('client_portfolio_videos').update(patch).eq('id', id).select().single();
    if (updErr) return res.status(500).json({ error: 'db_update_failed', message: updErr.message });
    return res.status(200).json({ ok: true, video: updated });
  }
  return res.status(200).json({ ok: true, video: row });
}

// Enhanced delete — also removes the Mux asset (fire-and-forget).
async function handleDeleteWithMux(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const id = url.searchParams.get('id');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const { data: existing } = await supabaseAdmin
    .from('client_portfolio_videos').select('client_id, mux_asset_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && ctx.clientId !== existing.client_id) return res.status(403).json({ error: 'forbidden' });
  const { error } = await supabaseAdmin.from('client_portfolio_videos').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  // Best-effort: also delete the Mux asset so Stephen's Mux storage
  // doesn't accumulate orphans. Missing token / 404 both non-fatal.
  if (existing.mux_asset_id) {
    deleteAsset(existing.mux_asset_id).catch(e => console.warn('[portfolio] mux asset delete failed:', e?.message));
  }
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method === 'GET') return await handleList(req, res);
  if (req.method === 'POST') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const action = url.searchParams.get('action') || 'upsert';
    if (action === 'upsert')       return await handleUpsert(req, res);
    if (action === 'reorder')      return await handleReorder(req, res);
    if (action === 'start-upload') return await handleStartUpload(req, res);
    if (action === 'check-upload') return await handleCheckUpload(req, res);
    return res.status(400).json({ error: 'unknown_action', action });
  }
  if (req.method === 'DELETE') return await handleDeleteWithMux(req, res);
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
