// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Normalize + validate a Mux playback ID before saving it to the DB.
// A silently-saved bad ID produces a dead player on a live portfolio
// page with no error surfacing anywhere — so validation happens on
// every save, not just when the operator first pastes it.
//
// Accepts, in this order of tolerance:
//   * Raw playback ID:                MOxiZEb302JK1hw…
//   * https://stream.mux.com/<id>     (with or without .m3u8 suffix)
//   * https://player.mux.com/<id>     (embed player URL)
//   * https://image.mux.com/<id>/…    (thumbnail URL)
// Rejects:
//   * Any input with whitespace or interior slashes after stripping
//   * Anything under 40 chars (too short to be a real playback ID)
//   * Signed / private playback IDs — surface as a specific error
//     (they will 403 without a JWT and won't play on the public site)
//
// Both `stream.mux.com/<id>.m3u8` and `image.mux.com/<id>/thumbnail.jpg`
// must return 200 to accept. HEAD requests keep the round-trip small.

const MUX_URL_PREFIXES = [
  'https://stream.mux.com/',
  'https://player.mux.com/',
  'https://image.mux.com/'
];

export function normalizePlaybackId(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, error: 'empty' };

  // Strip URL prefixes if present
  for (const pref of MUX_URL_PREFIXES) {
    if (s.toLowerCase().startsWith(pref)) {
      s = s.slice(pref.length);
      break;
    }
  }
  // Chop the .m3u8 suffix and anything after the first path segment
  // (image.mux.com/<id>/thumbnail.jpg → keep only <id>)
  s = s.split('?')[0].split('#')[0];
  const firstSlash = s.indexOf('/');
  if (firstSlash > 0) s = s.slice(0, firstSlash);
  if (s.toLowerCase().endsWith('.m3u8')) s = s.slice(0, -5);
  s = s.replace(/\/+$/, '').trim();

  if (!s) return { ok: false, error: 'empty_after_normalize' };
  if (/\s/.test(s)) return { ok: false, error: 'contains_whitespace' };
  if (s.length < 40) return {
    ok: false,
    error: 'too_short',
    message: 'That looks like a Mux Asset ID, not a Playback ID. Playback IDs are 44+ characters. Find them in Mux dashboard → Asset → Playback IDs.'
  };
  // Playback IDs are URL-safe base64 + a couple of legal delimiters;
  // strict enough to catch obvious pastes-of-a-URL that our stripper
  // missed while permissive enough to survive Mux's schema changes.
  if (!/^[A-Za-z0-9_\-.]+$/.test(s)) return {
    ok: false,
    error: 'illegal_chars',
    message: 'Playback ID contains characters we don\'t recognize. Copy just the ID string from Mux, no surrounding text.'
  };
  return { ok: true, id: s };
}

// HEAD-check both stream + thumbnail URLs. Returns a shaped verdict —
// callers translate to HTTP responses. Never throws; all failure modes
// come back as { ok:false, ... }.
export async function validatePlaybackIdLive(playbackId, { timeoutMs = 6000 } = {}) {
  const norm = normalizePlaybackId(playbackId);
  if (!norm.ok) return { ok: false, stage: 'normalize', ...norm };
  const id = norm.id;

  const streamUrl = `https://stream.mux.com/${encodeURIComponent(id)}.m3u8`;
  const thumbUrl  = `https://image.mux.com/${encodeURIComponent(id)}/thumbnail.jpg`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let streamRes, thumbRes;
  try {
    [streamRes, thumbRes] = await Promise.all([
      fetch(streamUrl, { method: 'HEAD', signal: ac.signal }),
      fetch(thumbUrl,  { method: 'HEAD', signal: ac.signal })
    ]);
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, stage: 'network', error: 'mux_unreachable',
      message: 'Could not reach Mux to verify (' + (e?.message || 'network') + '). Try again in a moment.' };
  }
  clearTimeout(timer);

  // Interpret each side. 403 is the classic signed-playback tell.
  const parts = { stream: streamRes.status, thumb: thumbRes.status };
  if (streamRes.status === 403 || thumbRes.status === 403) {
    return { ok: false, stage: 'signed', id, parts,
      error: 'signed_playback_id',
      message: 'This is a signed/private playback ID. In the Mux dashboard, edit the asset → Playback IDs → set policy to Public, or add a new Public Playback ID and paste that one.' };
  }
  if (streamRes.status === 404 || thumbRes.status === 404) {
    return { ok: false, stage: 'not_found', id, parts,
      error: 'playback_id_not_found',
      message: 'Playback ID not found in Mux. Double-check you copied the Playback ID (not the Asset ID) from Mux dashboard.' };
  }
  if (streamRes.status < 200 || streamRes.status >= 300 || thumbRes.status < 200 || thumbRes.status >= 300) {
    return { ok: false, stage: 'unexpected', id, parts,
      error: 'mux_error',
      message: `Mux returned unexpected status (stream=${streamRes.status}, thumb=${thumbRes.status}). Retry, and if it persists, check the asset\'s Playback Policy.` };
  }
  return { ok: true, id, parts };
}
