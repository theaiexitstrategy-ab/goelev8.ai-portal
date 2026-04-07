import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const CLIENT_FIELDS =
  'id, name, slug, twilio_phone_number, credit_balance, billing_paused, ' +
  'auto_reload_enabled, auto_reload_threshold, auto_reload_pack, ' +
  'stripe_connected_account_id, welcome_sms_enabled, welcome_sms_template';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;
  // Admins are allowed in without a client_id (they may not be impersonating yet).
  const ctx = await requireUser(req, res, { requireClient: false }); if (!ctx) return;

  if (req.method === 'GET') {
    let client = null;
    if (ctx.clientId) {
      const { data } = await supabaseAdmin
        .from('clients').select(CLIENT_FIELDS).eq('id', ctx.clientId).single();
      client = data;
    }
    return res.status(200).json({
      user: { id: ctx.user.id, email: ctx.user.email },
      isAdmin: !!ctx.isAdmin,
      client,
      // Public Supabase config exposed so the browser can open a Realtime
      // connection for live lead/booking/call notifications. Anon key is
      // safe in the browser; RLS still enforces tenant isolation.
      supabase: {
        url: process.env.SUPABASE_URL || null,
        anon_key: process.env.SUPABASE_ANON_KEY || null
      }
    });
  }

  // PATCH: client owner self-serve fields. Admins editing via impersonation
  // also flow through here, which is fine.
  if (!ctx.clientId) return res.status(400).json({ error: 'no_client_context' });
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
