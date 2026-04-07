import { createClient } from '@supabase/supabase-js';
import { methodGuard, readJson } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const { email, password } = await readJson(req);
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });

  return res.status(200).json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email }
  });
}
