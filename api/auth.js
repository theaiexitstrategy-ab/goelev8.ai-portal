import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireUser, methodGuard, readJson } from '../lib/auth.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  if (action === 'login') {
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

  if (action === 'change-password') {
    if (!methodGuard(req, res, ['POST'])) return;
    const ctx = await requireUser(req, res); if (!ctx) return;
    const { new_password } = await readJson(req);
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(ctx.user.id, {
      password: new_password
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown_action' });
}
