import { supabaseAdmin, supabaseForUser } from './supabase.js';

export function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Authenticate a request and return:
//   { user, isAdmin, clientId, role, sb }
//
// Behavior:
//  - Plain client user: returns their client_id (or 403 if unlinked).
//  - Platform admin without impersonation header:
//      returns { isAdmin: true, clientId: null }. Caller must handle null.
//  - Platform admin WITH x-admin-as-client header:
//      returns { isAdmin: true, clientId: <header>, sb: serviceRoleClient }.
//      All existing portal endpoints transparently scope to the impersonated
//      client because they read ctx.clientId and use ctx.sb.
//
// requireClient=true (default) keeps the legacy contract: 403 if no clientId.
// Pass requireClient=false from /me and admin endpoints that should accept
// admin-without-impersonation.
export async function requireUser(req, res, { requireClient = true } = {}) {
  const token = getToken(req);
  if (!token) { res.status(401).json({ error: 'unauthorized' }); return null; }

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) { res.status(401).json({ error: 'invalid_token' }); return null; }
  const user = data.user;

  // Check admin status first.
  const { data: adminRow } = await supabaseAdmin
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  const isAdmin = !!adminRow;

  // Admin impersonation header
  const asClient = req.headers['x-admin-as-client'] || req.headers['X-Admin-As-Client'];
  if (isAdmin && asClient) {
    return {
      user, isAdmin: true, role: 'admin',
      clientId: String(asClient),
      // Service-role client: bypasses RLS so admin can see/write anything.
      sb: supabaseAdmin
    };
  }

  if (isAdmin) {
    return { user, isAdmin: true, role: 'admin', clientId: null, sb: supabaseAdmin };
  }

  // Regular client user
  const { data: link } = await supabaseAdmin
    .from('client_users')
    .select('client_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!link) {
    if (requireClient) { res.status(403).json({ error: 'no_client_assigned' }); return null; }
    return { user, isAdmin: false, role: null, clientId: null, sb: supabaseForUser(token) };
  }
  return {
    user, isAdmin: false,
    clientId: link.client_id,
    role: link.role,
    sb: supabaseForUser(token)
  };
}

// Convenience: hard-fail unless the caller is a platform admin.
export async function requireAdmin(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return null;
  if (!ctx.isAdmin) { res.status(403).json({ error: 'admin_only' }); return null; }
  return ctx;
}

export function methodGuard(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    res.status(405).json({ error: 'method_not_allowed' });
    return false;
  }
  return true;
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
