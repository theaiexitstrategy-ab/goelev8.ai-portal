import { supabaseAdmin } from '../../lib/supabase.js';
import { requireUser, methodGuard, readJson } from '../../lib/auth.js';

export default async function handler(req, res) {
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
