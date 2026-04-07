import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, name, slug, twilio_phone_number, credit_balance, auto_reload_enabled, auto_reload_threshold, auto_reload_pack, stripe_connected_account_id')
    .eq('id', ctx.clientId).single();
  return res.status(200).json({
    user: { id: ctx.user.id, email: ctx.user.email },
    client
  });
}
