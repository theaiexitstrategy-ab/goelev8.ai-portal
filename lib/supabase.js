import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertEnv() {
  const missing = [];
  if (!url) missing.push('SUPABASE_URL');
  if (!anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new Error('Missing Supabase env vars: ' + missing.join(', '));
  }
}

// Lazy proxy: throws a clear error on first use, not at module load.
function lazy(fn) {
  let inst = null;
  return new Proxy({}, {
    get(_, prop) {
      if (!inst) { assertEnv(); inst = fn(); }
      const v = inst[prop];
      return typeof v === 'function' ? v.bind(inst) : v;
    }
  });
}

export const supabaseAdmin = lazy(() => createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
}));

export function supabaseForUser(accessToken) {
  assertEnv();
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false }
  });
}
