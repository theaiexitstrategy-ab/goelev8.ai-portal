import { createClient } from '@supabase/supabase-js';

// Second Supabase client for The AI Exit Strategy course backend.
// TAES lives at project uouoczmxigizkqszagdl in a separate Supabase
// project from the portal, so its curriculum / enrollment / progress /
// community data can't be reached via the shared supabaseAdmin client.
//
// Reads two env vars from Vercel (add both before this client works):
//   SUPABASE_URL_TAES              — https://uouoczmxigizkqszagdl.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY_TAES — the service_role key for that project
//
// Service-role is required because the portal reads across every tenant
// (student, lesson, enrollment) as an admin operation — the anon key
// with RLS would only surface rows for the currently authenticated
// TAES user, which isn't what the portal needs.
const url = process.env.SUPABASE_URL_TAES;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY_TAES;

function assertEnv() {
  const missing = [];
  if (!url) missing.push('SUPABASE_URL_TAES');
  if (!serviceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY_TAES');
  if (missing.length) {
    throw new Error('TAES Supabase env vars missing: ' + missing.join(', ')
      + ' — add them in Vercel then redeploy. The TAES project ref is uouoczmxigizkqszagdl.');
  }
}

// Cheap "are we wired up?" check for handlers that want to render a
// friendly "not configured" state instead of throwing. Returns true
// only when both env vars are set.
export function isTaesConfigured() {
  return !!(url && serviceKey);
}

// Lazy proxy — same pattern as the portal's supabaseAdmin: no error at
// module load, clear error on first use if env vars are missing.
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

export const taesAdmin = lazy(() => createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
}));
