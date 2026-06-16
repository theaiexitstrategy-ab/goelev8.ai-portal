// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cron worker that pulls recent Stripe Checkout Sessions across every
// Connect-linked tenant and ingests any paid sessions that haven't
// landed in merch_orders yet. The portal Stripe webhook (api/stripe/
// webhook.js) is the primary path for getting orders into the portal
// in real time, BUT Stripe Connect webhooks require an explicit "Listen
// to events on Connected accounts" toggle in Dashboard. Until that
// toggle is reliably on for every account, this cron is the safety
// net so:
//   - Orders show up in the portal Merch → Orders tab within ~5 min
//     of the customer paying, regardless of webhook state.
//   - Push notifications + order-received SMS fire via the existing
//     ingestExternalMerchOrder() path (sendPushToClient,
//     sendPushToAdmins, sendOrderReceivedSms).
//
// Auth: same Bearer CRON_SECRET pattern as process-nudges. Vercel cron
// sends it automatically. Manual invocation via curl works too:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://portal.goelev8.ai/api/cron/sync-stripe-orders

import { supabaseAdmin } from '../../lib/supabase.js';
import { backfillExternalMerchOrders } from '../../lib/merch-ingest.js';

// How far back each cron tick scans on each tenant's connected
// account. 24 hours is roomy — even if a tick fails or a deploy is
// briefly down, the next run within 5 min catches anything missed.
const LOOKBACK_HOURS = 24;
const MAX_SESSIONS_PER_TENANT = 50;

function authorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev mode — no secret configured
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  // Pull every tenant that has finished Stripe Connect OAuth. Tenants
  // without a connected account id can't be charged through us, so
  // there's nothing to ingest for them.
  const { data: tenants, error } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, stripe_connected_account_id')
    .not('stripe_connected_account_id', 'is', null);
  if (error) {
    console.error('[sync-stripe-orders] tenant lookup failed:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const results = [];
  const totals = { tenants: 0, scanned: 0, ingested: 0, idempotent: 0, errors: 0 };

  for (const t of tenants || []) {
    totals.tenants++;
    try {
      const r = await backfillExternalMerchOrders({
        stripeAccount: t.stripe_connected_account_id,
        hoursBack:     LOOKBACK_HOURS,
        maxSessions:   MAX_SESSIONS_PER_TENANT
      });
      totals.scanned    += r.scanned    || 0;
      totals.ingested   += r.ingested   || 0;
      totals.idempotent += r.idempotent || 0;
      totals.errors     += (r.errors || []).length;
      // Only log per-tenant rows when something actually happened —
      // a quiet run is the steady state and shouldn't fill the log.
      if (r.ingested > 0 || r.errors?.length) {
        results.push({ slug: t.slug, name: t.name, ...r });
        console.log('[sync-stripe-orders]', t.slug,
          `ingested=${r.ingested} idempotent=${r.idempotent} scanned=${r.scanned}`);
      }
    } catch (e) {
      totals.errors++;
      results.push({ slug: t.slug, name: t.name, error: e?.message || String(e) });
      console.error('[sync-stripe-orders]', t.slug, 'crashed:', e?.message);
    }
  }

  if (totals.ingested > 0) {
    console.log(`[sync-stripe-orders] tick: ${totals.ingested} new orders across ${totals.tenants} tenants`);
  }
  return res.status(200).json({ totals, results });
}
