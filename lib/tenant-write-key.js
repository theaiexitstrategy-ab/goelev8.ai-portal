// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Shared auth helper for /api/external/experience-* endpoints called
// by tenant funnel sites (konqueredkocktails.com, etc.). Verifies:
//   1. Presence of x-portal-write-key header
//   2. sha256(header) matches an active row in tenant_write_keys
//   3. Request Origin (when present) is in that row's allowed_origins
//      (or the list is empty — treated as "any origin allowed",
//      useful during initial tenant setup + testing)
//
// Returns { ok:true, clientId } on success, or { ok:false, status,
// error } on any failure. Callers should also set CORS headers
// (setCorsHeaders below) so preflights pass. Never returns the raw
// key or the hash.

import { createHash } from 'node:crypto';
import { supabaseAdmin } from './supabase.js';

export function setCorsHeaders(res, origin) {
  // Allow requested origin verbatim when it matches an allowed origin
  // on the write key. Callers pass the SPECIFIC allowed origin they
  // matched (or '*' during dev if origins list is empty).
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, x-portal-write-key, content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export async function authTenantWriteKey(req) {
  const raw = String(req.headers['x-portal-write-key'] || req.headers['X-Portal-Write-Key'] || '').trim();
  if (!raw) return { ok: false, status: 401, error: 'missing_write_key' };
  const hash = createHash('sha256').update(raw).digest('hex');
  const { data: row, error } = await supabaseAdmin
    .from('tenant_write_keys')
    .select('id, client_id, allowed_origins, active, revoked_at')
    .eq('key_hash', hash)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: 'write_key_lookup_failed' };
  if (!row || row.active === false || row.revoked_at) {
    return { ok: false, status: 401, error: 'invalid_or_revoked_write_key' };
  }
  const origin = String(req.headers.origin || '').trim();
  const allowedOrigins = Array.isArray(row.allowed_origins) ? row.allowed_origins : [];
  // Empty allowed_origins list = permissive (setup mode). Once
  // populated, requests from other origins are rejected. Origin
  // header is optional for server-to-server calls (curl, Node
  // fetch); when absent we allow the request but reflect back a
  // safe placeholder.
  let allowOriginForCors = '*';
  if (allowedOrigins.length) {
    if (origin && !allowedOrigins.includes(origin)) {
      return { ok: false, status: 403, error: 'origin_not_allowed', origin };
    }
    allowOriginForCors = origin || allowedOrigins[0];
  } else if (origin) {
    allowOriginForCors = origin;
  }
  return { ok: true, clientId: row.client_id, keyId: row.id, corsOrigin: allowOriginForCors };
}
