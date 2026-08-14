// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// CORS for the portal's PUBLIC, unauthenticated write beacons — the
// endpoints tenant marketing sites call straight from the browser:
//   - POST /api/track/view        (page views  → funnel_views)
//   - POST /api/webhooks/lead     (form capture → leads, via /api/events?action=lead)
//
// Why this exists (bug fixed 2026-08-14): both endpoints were silently
// dropping every cross-origin request from every tenant site.
//
//   1. /api/track/view sent NO CORS headers and had no OPTIONS branch.
//      Note this broke the sendBeacon path too, not just the fetch
//      fallback: embed/track.js posts a Blob typed 'application/json',
//      and application/json is NOT a CORS-safelisted request content
//      type, so the beacon gets preflighted like any other request.
//      No preflight response → browser drops it → funnel_views has been
//      undercounting platform-wide.
//
//   2. /api/webhooks/lead sent 'Access-Control-Allow-Origin: *', which
//      the CORS spec forbids pairing with a credentialed request. At
//      least one tenant site posts its own form data with
//      credentials:'include' (that caller lives in the tenant repo, not
//      in embed/track.js), so the wildcard rejected it outright.
//
// The fix for (2) has to be server-side precisely because we can't edit
// every tenant's form code: reflect the caller's specific Origin rather
// than '*', and allow credentials. Reflecting requires `Vary: Origin`
// so a CDN can't serve one tenant's ACAO header to another tenant.
//
// Is reflect-any-origin safe here? For THESE endpoints, yes:
//   - Neither does cookie- or session-based auth. /api/track/view has no
//     auth at all; the lead webhook authenticates on the slug+secret in
//     the request body.
//   - Neither returns anything derived from the caller's identity — both
//     answer a flat { ok: true }.
// So there is no session to ride and nothing to exfiltrate. Do NOT reuse
// this helper on an endpoint that reads cookies or returns user-scoped
// data; use lib/tenant-write-key.js's setCorsHeaders (allowlisted
// origins) for anything authenticated.

// Reflect the request Origin and permit credentials. Falls back to '*'
// only when the request carried no Origin header at all (server-to-server
// callers, curl), where credentials can't be in play anyway.
export function setPublicCors(res, origin, { methods = 'POST, OPTIONS', headers = 'Content-Type' } = {}) {
  const o = String(origin || '').trim();
  if (o) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  // Required whenever ACAO is computed from the request — without it a
  // shared cache can hand tenant B the header generated for tenant A.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Access-Control-Max-Age', '86400');
}

// Handle the preflight in one line at the top of a handler. Returns true
// when the request was an OPTIONS preflight and has been answered — the
// caller should return immediately.
export function handlePreflight(req, res, opts) {
  setPublicCors(res, req.headers.origin, opts);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}
