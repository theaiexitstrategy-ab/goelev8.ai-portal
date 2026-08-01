// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Vercel cron — fires every 15 min. Two responsibilities:
//   1. Fallback poll of every tenant with a Google Calendar link,
//      in case the push webhook missed something (Google can drop
//      push notifications during outages).
//   2. Renew push channels within 24h of expiration (they're issued
//      for ~7 days but Google may cap shorter).
//
// vercel.json cron:
//   { "path": "/api/cron/gcal-sync", "schedule": "*/15 * * * *" }
//
// Never throws — a failing tenant is logged with last_sync_error;
// the loop continues so one bad token doesn't stop others.

import { supabaseAdmin } from '../../lib/supabase.js';
import { loadTenantTokens, listEventsIncremental, syncBusyCache, watchCalendar, stopChannel } from '../../lib/gcal.js';

const RENEW_HOURS_BEFORE = 24;

export default async function handler(req, res) {
  // Same CRON_SECRET guard as other cron endpoints.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'unauthorized' });
  }

  const { data: rows, error } = await supabaseAdmin
    .from('client_google_calendar')
    .select('client_id, calendar_id, sync_token, channel_id, channel_resource_id, channel_expiration')
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  if (!rows || !rows.length) return res.status(200).json({ ok: true, processed: 0 });

  const summary = { processed: 0, synced: 0, renewed: 0, errors: 0, details: [] };
  const renewCutoff = new Date(Date.now() + RENEW_HOURS_BEFORE * 3600_000);

  for (const row of rows) {
    summary.processed++;
    try {
      const t = await loadTenantTokens(row.client_id);
      // (1) incremental sync
      try {
        const { items, syncToken } = await listEventsIncremental(t.access_token, row.calendar_id || 'primary', { syncToken: row.sync_token });
        const applied = await syncBusyCache(row.client_id, row.calendar_id || 'primary', items);
        await supabaseAdmin.from('client_google_calendar').update({
          sync_token: syncToken || row.sync_token,
          last_synced_at: new Date().toISOString(),
          last_sync_error: null
        }).eq('client_id', row.client_id);
        summary.synced++;
        summary.details.push({ client_id: row.client_id, applied });
      } catch (e) {
        // A stale syncToken returns 410. Recover by clearing it —
        // next tick will re-sync from a timeMin window.
        if (e.status === 410) {
          await supabaseAdmin.from('client_google_calendar')
            .update({ sync_token: null, last_sync_error: 'sync_token_stale — will re-sync from window' })
            .eq('client_id', row.client_id);
        } else {
          await supabaseAdmin.from('client_google_calendar')
            .update({ last_sync_error: e.message }).eq('client_id', row.client_id);
          summary.errors++;
          summary.details.push({ client_id: row.client_id, error: e.message });
        }
      }
      // (2) renew channel if expiring soon
      const exp = row.channel_expiration ? new Date(row.channel_expiration) : null;
      if (process.env.GCAL_PUSH_WEBHOOK_URL && (!exp || exp < renewCutoff)) {
        try {
          if (row.channel_id) await stopChannel(t.access_token, row.channel_id, row.channel_resource_id);
          const ch = await watchCalendar(t.access_token, row.calendar_id || 'primary', {
            channelId: 'kb-' + row.client_id.slice(0, 8) + '-' + Date.now().toString(36),
            token: process.env.GCAL_PUSH_TOKEN || 'nopush',
            expirationMs: Date.now() + 6 * 86400_000
          });
          await supabaseAdmin.from('client_google_calendar').update({
            channel_id: ch.channelId, channel_resource_id: ch.resourceId, channel_expiration: ch.expiration
          }).eq('client_id', row.client_id);
          summary.renewed++;
        } catch (e) {
          console.warn('[gcal cron] renew failed for', row.client_id, e.message);
        }
      }
    } catch (e) {
      summary.errors++;
      summary.details.push({ client_id: row.client_id, error: e.message });
    }
  }
  return res.status(200).json({ ok: true, ...summary });
}
