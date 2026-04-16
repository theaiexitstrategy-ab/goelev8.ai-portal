// POST /api/portal/push-test — send a test push notification
// Works for both client users (pushes to client) and admins (pushes to admins)
import { requireUser, methodGuard } from '../../lib/auth.js';
import { sendPushToClient, sendPushToAdmins } from '../../lib/push.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res, { requireClient: false }); if (!ctx) return;

  const hasVapidPublic = !!process.env.VAPID_PUBLIC_KEY;
  const hasVapidPrivate = !!process.env.VAPID_PRIVATE_KEY;

  if (!hasVapidPublic || !hasVapidPrivate) {
    return res.status(500).json({
      error: 'vapid_not_configured',
      detail: `VAPID_PUBLIC_KEY: ${hasVapidPublic ? 'set' : 'MISSING'}, VAPID_PRIVATE_KEY: ${hasVapidPrivate ? 'set' : 'MISSING'}`
    });
  }

  try {
    if (ctx.clientId) {
      await sendPushToClient(
        ctx.clientId,
        '🔔 Test Notification',
        'Push notifications are working! You will receive alerts for new leads, SMS replies, and missed calls.',
        '/leads'
      );
    }
    // Always also send to admin subscriptions (client_id IS NULL)
    await sendPushToAdmins(
      '🔔 Test Notification',
      'Admin push notifications are working! You will receive alerts for all client activity.',
      '/admin'
    );
    return res.status(200).json({ ok: true, client_id: ctx.clientId || null });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
