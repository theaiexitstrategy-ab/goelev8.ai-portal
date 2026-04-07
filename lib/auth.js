import { supabaseAdmin, supabaseForUser } from './supabase.js';

// Extract Bearer token from Authorization header
export function getToken(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Authenticate request -> { user, clientId, sb (RLS-bound client) }
export async function requireUser(req, res) {
  const token = getToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: 'invalid_token' });
    return null;
  }
  const user = data.user;
  const { data: link } = await supabaseAdmin
    .from('client_users')
    .select('client_id, role')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!link) {
    res.status(403).json({ error: 'no_client_assigned' });
    return null;
  }
  return {
    user,
    clientId: link.client_id,
    role: link.role,
    sb: supabaseForUser(token)
  };
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
