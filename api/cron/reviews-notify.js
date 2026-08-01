// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Vercel cron — fires every 5 minutes. Picks up reviews whose
// tenant_alert_sent_at is NULL, notifies the tenant owner via
// lib/reviews-notify.js (push + email + SMS), then stamps the row so
// it's never re-notified.
//
// vercel.json entry:
//   { "path": "/api/cron/reviews-notify", "schedule": "*/5 * * * *" }
//
// Guardrails:
//   * Caps to MAX_PER_RUN rows per tick so a backfilled batch doesn't
//     saturate Twilio/Resend if we've been down for hours.
//   * Rows only pending for MAX_AGE_HOURS are dropped without notify
//     (still stamped) so old backlogs from before this cron existed
//     don't spam Stephen.
//   * Vercel cron requests carry an auth header (CRON_SECRET); if
//     set, we require it. Manual /api/cron/reviews-notify?force=1
//     hits from admin work with a service-role bypass.

import { supabaseAdmin } from '../../lib/supabase.js';
import { notifyReviewArrived } from '../../lib/reviews-notify.js';

const MAX_PER_RUN   = 20;
const MAX_AGE_HOURS = 24 * 7;   // one week — anything older gets silently marked

export default async function handler(req, res) {
  // Vercel Cron adds `authorization: Bearer <CRON_SECRET>` when the
  // env var is set. Reject other callers unless they pass the same
  // secret manually (useful for backfill / local test).
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  const cutoff = new Date(Date.now() - MAX_AGE_HOURS * 3600_000).toISOString();

  const { data: rows, error } = await supabaseAdmin
    .from('reviews')
    .select('*')
    .is('tenant_alert_sent_at', null)
    .order('created_at', { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) return res.status(500).json({ error: error.message });

  if (!rows || !rows.length) return res.status(200).json({ ok: true, processed: 0, note: 'nothing pending' });

  const summary = { processed: 0, notified: 0, skipped_old: 0, errors: 0, details: [] };
  for (const row of rows) {
    summary.processed++;
    // Skip-and-stamp very old rows so they stop showing up.
    if (row.created_at && row.created_at < cutoff) {
      await supabaseAdmin.from('reviews')
        .update({ tenant_alert_sent_at: new Date().toISOString() })
        .eq('id', row.id);
      summary.skipped_old++;
      summary.details.push({ id: row.id, action: 'skipped_old' });
      continue;
    }
    try {
      const result = await notifyReviewArrived({ review: row });
      // Always stamp — if any channel succeeded we don't want to
      // duplicate. If every channel failed we'd rather not repeat
      // the failure indefinitely; the operator can still see the row
      // in the portal Reviews tab.
      await supabaseAdmin.from('reviews')
        .update({ tenant_alert_sent_at: new Date().toISOString() })
        .eq('id', row.id);
      if (result.ok) { summary.notified++; summary.details.push({ id: row.id, action: 'notified', results: result.results }); }
      else           { summary.errors++;  summary.details.push({ id: row.id, action: 'notify_error', error: result.error }); }
    } catch (e) {
      summary.errors++;
      summary.details.push({ id: row.id, action: 'exception', error: e?.message || String(e) });
      // Still stamp so we don't loop on the same bad row.
      await supabaseAdmin.from('reviews')
        .update({ tenant_alert_sent_at: new Date().toISOString() })
        .eq('id', row.id);
    }
  }
  return res.status(200).json({ ok: true, ...summary });
}
