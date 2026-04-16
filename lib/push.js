import webpush from 'web-push';
import { supabaseAdmin } from './supabase.js';

// Send a push notification to all subscribed devices for a client.
// Stale subscriptions (410 Gone / 404) are automatically purged.
export async function sendPushToClient(clientId, title, body, url = '/') {
  try {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:support@goelev8.ai',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('client_id', clientId);
    if (!subs?.length) return;
    const payload = JSON.stringify({ title, body, url });
    for (const sub of subs) {
      try {
        await webpush.sendNotification({
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        }, payload);
      } catch (e) {
        if (e.statusCode === 410 || e.statusCode === 404) {
          await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
        }
      }
    }
  } catch (e) {
    console.error('[push] notification error:', e.message);
  }
}
