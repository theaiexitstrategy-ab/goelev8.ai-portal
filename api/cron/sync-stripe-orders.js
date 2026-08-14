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
import {
  backfillLegacyEventSessions, describeLegacyEventSessions, traceConnectedAccount
} from '../../lib/event-ingest.js';

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

  // ?describe=1 — read-only inventory of Checkout Sessions on the platform
  // account. Answers "are the tenant marketing site's charges even landing
  // here?" directly instead of inferring it from a zero ingest count.
  // Writes nothing and returns no personal data (see
  // describeLegacyEventSessions). Same CRON_SECRET gate as the sync itself.
  {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // ?trace=<acct_...>[&transfer=<tr_...>] — follow a destination-charge
    // transfer into the connected account. Answers "the charge says it
    // transferred but neither side sees the money" with facts: whose
    // account it actually is, whether payouts are enabled, and whether
    // the funds are available or merely pending. Read-only.
    const traceAcct = url.searchParams.get('trace');
    if (traceAcct) {
      try {
        const out = await traceConnectedAccount({
          accountId: traceAcct,
          transferId: url.searchParams.get('transfer') || null
        });
        return res.status(200).json(out);
      } catch (e) {
        return res.status(500).json({ error: e?.message || 'trace_failed' });
      }
    }

    if (url.searchParams.get('describe') === '1') {
      const requested = parseInt(url.searchParams.get('hours') || '', 10);
      const hoursBack = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 2160) : 720;
      try {
        const rows = await describeLegacyEventSessions({ hoursBack, maxSessions: 100 });
        return res.status(200).json({ hours_back: hoursBack, count: rows.length, sessions: rows });
      } catch (e) {
        return res.status(500).json({ error: e?.message || 'describe_failed' });
      }
    }
  }

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

  // ── Phase 2: event seats sold by tenant marketing sites ───────────
  // theflexfacility.com/bootcamp creates DESTINATION charges using a
  // restricted key on the GoElev8 platform account, so those Checkout
  // Sessions sit on OUR account — a single platform-scoped scan finds
  // them all, no per-tenant loop and nothing to deploy on the tenant
  // side. Folded into this cron rather than a sixth Vercel cron entry
  // since it's the same job: reconcile Stripe into the portal on a
  // webhook-independent path.
  //
  // 24h lookback matches phase 1. The one-time historical import uses
  // the same helper with a wider window — see
  // scripts/backfill-bootcamp-signups.mjs.
  // ?hours=N widens the scan for a ONE-TIME historical import. The
  // scheduled tick deliberately stays at 24h — scanning 30 days of
  // sessions every 5 minutes would be pure waste — but that default
  // means seats sold before this shipped are outside the window and
  // never get picked up. Pass ?hours=720 once by hand to sweep them in;
  // ingestion is idempotent on stripe_session_id, so a wide re-run only
  // adds what's missing.
  let events = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requested = parseInt(url.searchParams.get('hours') || '', 10);
    const hoursBack = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1), 2160)   // clamp to 1h..90d
      : LOOKBACK_HOURS;
    events = await backfillLegacyEventSessions({
      hoursBack,
      maxSessions: 100
    });
    events.hours_back = hoursBack;
    if (events.ingested > 0 || events.errors?.length) {
      console.log('[sync-stripe-orders] event seats',
        `ingested=${events.ingested} idempotent=${events.idempotent} scanned=${events.scanned}`
        + (events.mismatched ? ` mismatched=${events.mismatched}` : ''));
    }
  } catch (e) {
    console.error('[sync-stripe-orders] event seat scan crashed:', e?.message);
    events = { error: e?.message || String(e) };
  }

  return res.status(200).json({ totals, results, events });
}
