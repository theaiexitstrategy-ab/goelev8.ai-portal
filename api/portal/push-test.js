// POST /api/portal/push-test — send a test push notification to the current user
// Used to verify the full push pipeline: subscription saved → VAPID → browser notification
import { requireUser, methodGuard } from '../../lib/auth.js';
import { sendPushToClient } from '../../lib/push.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  // Debug info
  const hasVapidPublic = !!process.env.VAPID_PUBLIC_KEY;
  const hasVapidPrivate = !!process.env.VAPID_PRIVATE_KEY;

  if (!hasVapidPublic || !hasVapidPrivate) {
    return res.status(500).json({
      error: 'vapid_not_configured',
      detail: `VAPID_PUBLIC_KEY: ${hasVapidPublic ? 'set' : 'MISSING'}, VAPID_PRIVATE_KEY: ${hasVapidPrivate ? 'set' : 'MISSING'}`
    });
  }

  try {
    await sendPushToClient(
      ctx.clientId,
      '🔔 Test Notification',
      'Push notifications are working! You will receive alerts for new leads, SMS replies, and missed calls.',
      '/leads'
    );
    return res.status(200).json({ ok: true, client_id: ctx.clientId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
