// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Google Calendar push notification receiver. Google POSTs (headers-
// only, empty body) to this URL whenever the watched calendar
// changes. Headers we care about:
//   X-Goog-Channel-Id       — the id we chose in watch()
//   X-Goog-Channel-Token    — the token we set on watch (matches GCAL_PUSH_TOKEN)
//   X-Goog-Resource-Id      — the resourceId Google issued
//   X-Goog-Resource-State   — 'sync' (initial) | 'exists' | 'not_exists'
//
// Correct behavior on receipt: respond 200 fast, then run an
// incremental sync using the tenant's stored syncToken. Google
// retries on non-200 with exponential backoff for a few hours, so
// we return 200 even if the follow-up sync fails — the fallback
// cron will re-attempt on its next tick.

import { supabaseAdmin } from '../../lib/supabase.js';
import { loadTenantTokens, listEventsIncremental, syncBusyCache } from '../../lib/gcal.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const channelId = req.headers['x-goog-channel-id'];
  const channelToken = req.headers['x-goog-channel-token'];
  const resourceState = req.headers['x-goog-resource-state'];

  // Validate the shared token — Google echoes whatever we set at
  // watch() time. Rejects noise from anyone hitting the URL.
  const expectedToken = process.env.GCAL_PUSH_TOKEN || 'nopush';
  if (channelToken !== expectedToken) {
    return res.status(401).json({ error: 'invalid_channel_token' });
  }

  // Google fires an initial 'sync' notification when watch() is
  // set up. Acknowledge but don't sync — the caller (portal/gcal.js
  // callback) just did the initial pull.
  if (resourceState === 'sync') return res.status(200).end();
  if (!channelId) return res.status(400).json({ error: 'missing_channel_id' });

  // Return 200 ASAP; do the actual sync in the background. Vercel
  // will keep the invocation alive for the full handler duration,
  // so we do the work inline but log rather than throw on failure.
  const { data: row } = await supabaseAdmin
    .from('client_google_calendar')
    .select('client_id, calendar_id, sync_token')
    .eq('channel_id', channelId).maybeSingle();
  if (!row) {
    // Unknown / stale channel — respond 200 (Google will stop
    // eventually) but log it in case operator wants to renew.
    console.warn('[gcal push] unknown channel_id:', channelId);
    return res.status(200).end();
  }

  try {
    const t = await loadTenantTokens(row.client_id);
    const { items, syncToken } = await listEventsIncremental(t.access_token, row.calendar_id || 'primary', { syncToken: row.sync_token });
    const applied = await syncBusyCache(row.client_id, row.calendar_id || 'primary', items);
    await supabaseAdmin.from('client_google_calendar').update({
      sync_token: syncToken || row.sync_token,
      last_synced_at: new Date().toISOString(),
      last_sync_error: null
    }).eq('client_id', row.client_id);
    console.log('[gcal push]', row.client_id, 'applied', applied);
  } catch (e) {
    console.error('[gcal push] sync failed:', e.message);
    await supabaseAdmin.from('client_google_calendar')
      .update({ last_sync_error: e.message }).eq('client_id', row.client_id);
  }
  return res.status(200).end();
}
