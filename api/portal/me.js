import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const CLIENT_FIELDS =
  'id, name, slug, twilio_phone_number, credit_balance, ' +
  'auto_reload_enabled, auto_reload_threshold, auto_reload_pack, ' +
  'stripe_connected_account_id, welcome_sms_enabled, welcome_sms_template';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  if (req.method === 'GET') {
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select(CLIENT_FIELDS)
      .eq('id', ctx.clientId).single();
    return res.status(200).json({
      user: { id: ctx.user.id, email: ctx.user.email },
      client
    });
  }

  // PATCH: only allow whitelisted fields the client owner can self-serve.
  const body = await readJson(req);
  const patch = {};
  if (typeof body.welcome_sms_enabled === 'boolean') patch.welcome_sms_enabled = body.welcome_sms_enabled;
  if (typeof body.welcome_sms_template === 'string') {
    const t = body.welcome_sms_template.trim();
    if (t.length > 1600) return res.status(400).json({ error: 'template_too_long' });
    patch.welcome_sms_template = t || null;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }
  const { data, error } = await supabaseAdmin
    .from('clients').update(patch).eq('id', ctx.clientId)
    .select(CLIENT_FIELDS).single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ client: data });
}
