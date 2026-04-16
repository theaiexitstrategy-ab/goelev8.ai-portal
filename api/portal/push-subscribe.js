// POST /api/portal/push-subscribe — save a browser push subscription
// DELETE /api/portal/push-subscribe — remove a subscription (on unsubscribe)
import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { endpoint, keys } = body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'missing subscription data' });
    }
    // Upsert: if endpoint already exists, update keys (browser may rotate)
    const { error } = await supabaseAdmin
      .from('push_subscriptions')
      .upsert({
        client_id: clientId,
        user_id: ctx.user.id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: req.headers['user-agent'] || null
      }, { onConflict: 'endpoint' });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // DELETE: remove subscription by endpoint
  const body = await readJson(req);
  const { endpoint } = body || {};
  if (!endpoint) return res.status(400).json({ error: 'missing endpoint' });
  await supabaseAdmin
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint)
    .eq('client_id', clientId);
  return res.status(200).json({ ok: true });
}
