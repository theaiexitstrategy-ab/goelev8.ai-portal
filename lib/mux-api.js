// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Thin wrapper for the Mux Video v1 API. Just enough surface to run
// the portal Portfolio's phone-upload flow — direct upload creation,
// upload status polling, asset lookup. No SDK dependency; raw fetch
// keeps the deploy small.
//
// Requires env vars:
//   MUX_TOKEN_ID       Mux access token id (Settings → API Access Tokens → any token with "Full access")
//   MUX_TOKEN_SECRET   Corresponding secret
//   MUX_UPLOAD_CORS_ORIGIN  (optional) origin allowed to PUT to the
//                           upload URL; defaults to PORTAL_BASE_URL or
//                           https://portal.goelev8.ai. Wildcard '*' is
//                           accepted but not recommended for prod.

const MUX_BASE = 'https://api.mux.com/video/v1';

function authHeader() {
  const id = process.env.MUX_TOKEN_ID;
  const secret = process.env.MUX_TOKEN_SECRET;
  if (!id || !secret) {
    throw new Error('MUX_TOKEN_ID / MUX_TOKEN_SECRET not set in env — add both in Vercel (Mux dashboard → Settings → API Access Tokens).');
  }
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function muxFetch(path, opts = {}) {
  const res = await fetch(MUX_BASE + path, {
    ...opts,
    headers: {
      'Authorization': authHeader(),
      'Content-Type':  'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const msg = json?.error?.messages?.join('; ') || json?.error?.type || `mux_http_${res.status}`;
    const err = new Error('mux: ' + msg);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json;
}

// Create a Direct Upload URL that the client PUTs the video file to.
// After the file lands, Mux processes it into an Asset with a public
// Playback ID. The upload_id is our correlation key while it's in flight.
export async function createDirectUpload(opts = {}) {
  const corsOrigin = opts.corsOrigin
    || process.env.MUX_UPLOAD_CORS_ORIGIN
    || process.env.PORTAL_BASE_URL
    || 'https://portal.goelev8.ai';
  // video_quality and encoding_tier are the SAME setting in two
  // generations of the Mux API — encoding_tier ('baseline'/'smart') was
  // replaced by video_quality ('basic'/'plus'/'premium'). Mux rejects a
  // request that specifies both, so sending them together turns every
  // upload into a 400. The old comment here called that combination
  // "harmless", which was true when it was written and stopped being
  // true when Mux started validating it.
  //
  // Send video_quality only. encodingTier stays supported as an explicit
  // opt-in for anyone pinned to the older field, but the two are now
  // mutually exclusive rather than belt-and-braces.
  const assetSettings = {
    playback_policy: ['public']
  };
  if (opts.encodingTier) {
    assetSettings.encoding_tier = opts.encodingTier;
  } else {
    assetSettings.video_quality = opts.videoQuality || 'basic';  // 'basic' | 'plus' | 'premium'
  }

  const body = {
    cors_origin: corsOrigin,
    new_asset_settings: assetSettings,
    // Kill any upload URL that hasn't been used within this many seconds.
    // Default 60 min gives Stephen plenty of time on flaky mobile networks.
    timeout: opts.timeoutSeconds || 3600
  };
  const res = await muxFetch('/uploads', { method: 'POST', body: JSON.stringify(body) });
  const data = res?.data;
  if (!data?.id || !data?.url) throw new Error('mux: unexpected upload response shape');
  return { upload_id: data.id, upload_url: data.url, cors_origin: corsOrigin };
}

// Fetch upload state. Returns { status, asset_id? } where status is
// one of: 'waiting' (URL not yet PUT to), 'asset_created' (Mux has
// the file and is processing), 'errored', 'cancelled', 'timed_out'.
// asset_id is populated once Mux starts processing.
export async function getUpload(uploadId) {
  const res = await muxFetch('/uploads/' + encodeURIComponent(uploadId));
  const d = res?.data || {};
  return {
    status:   d.status || 'unknown',
    asset_id: d.asset_id || null,
    error:    d.error || null
  };
}

// Fetch asset. Returns { status, playback_id?, duration_seconds? }
// status: 'preparing' | 'ready' | 'errored'
export async function getAsset(assetId) {
  const res = await muxFetch('/assets/' + encodeURIComponent(assetId));
  const d = res?.data || {};
  const publicId = (d.playback_ids || []).find(p => p.policy === 'public')?.id
    || (d.playback_ids || [])[0]?.id
    || null;
  return {
    status:           d.status || 'unknown',
    playback_id:      publicId,
    duration_seconds: d.duration ?? null,
    errors:           d.errors || null
  };
}

// Convenience: given an upload_id, walk it all the way to ready.
// Never blocks — returns whatever state it's in right now.
export async function resolveUploadToAsset(uploadId) {
  const up = await getUpload(uploadId);
  if (up.status === 'errored' || up.status === 'cancelled' || up.status === 'timed_out') {
    return { stage: 'upload', status: up.status,
      error_message: up.error?.messages?.join('; ') || up.status };
  }
  if (!up.asset_id) {
    // Upload URL issued but no bytes yet, OR bytes uploaded but Mux
    // hasn't spun up an asset yet.
    return { stage: 'upload', status: up.status, asset_id: null };
  }
  const a = await getAsset(up.asset_id);
  return {
    stage:            'asset',
    upload_status:    up.status,
    asset_id:         up.asset_id,
    asset_status:     a.status,
    playback_id:      a.playback_id,
    duration_seconds: a.duration_seconds,
    error_message:    a.errors ? JSON.stringify(a.errors).slice(0, 500) : null
  };
}

// Delete an asset (called when the operator deletes a video from the
// portal). Safe on 404 — treat as already gone.
export async function deleteAsset(assetId) {
  if (!assetId) return { ok: true, skipped: true };
  try {
    await muxFetch('/assets/' + encodeURIComponent(assetId), { method: 'DELETE' });
    return { ok: true };
  } catch (e) {
    if (e.status === 404) return { ok: true, already_gone: true };
    return { ok: false, error: e.message };
  }
}
