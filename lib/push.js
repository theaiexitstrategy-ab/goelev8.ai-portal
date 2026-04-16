import webpush from 'web-push';
import { supabaseAdmin } from './supabase.js';

function ensureVapid() {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:support@goelev8.ai',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return true;
}

async function deliverToSubs(subs, payload) {
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
}

// Send a push notification to all subscribed devices for a client.
export async function sendPushToClient(clientId, title, body, url = '/') {
  try {
    if (!ensureVapid()) return;
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('client_id', clientId);
    if (!subs?.length) return;
    await deliverToSubs(subs, JSON.stringify({ title, body, url }));
  } catch (e) {
    console.error('[push] client notification error:', e.message);
  }
}

// Send a push notification to all platform admins (subscriptions with
// client_id IS NULL — these belong to admin users who aren't tied to
// a single tenant). Includes the client name in the notification so
// the admin knows which tenant the event is for.
export async function sendPushToAdmins(title, body, url = '/') {
  try {
    if (!ensureVapid()) return;
    const { data: subs } = await supabaseAdmin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .is('client_id', null);
    if (!subs?.length) return;
    await deliverToSubs(subs, JSON.stringify({ title, body, url }));
  } catch (e) {
    console.error('[push] admin notification error:', e.message);
  }
}
