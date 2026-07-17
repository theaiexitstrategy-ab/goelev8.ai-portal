// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Vercel cron — finalizes the prior calendar month's Free Flow Fitness
// billing statement. Registered in vercel.json at 05:00 UTC on the 1st
// of each month (midnight America/Chicago-ish; runs slightly after
// month boundary so any last-minute bookings have already counted).
//
// Auth: Vercel's cron header carries CRON_SECRET via ?secret= query
// param OR the Authorization header — mirror the other crons here.
// Off-schedule triggers without the secret are rejected.
//
// Behavior:
//   - Computes the prior YYYY-MM in America/Chicago.
//   - Marks that period's freeflow_billing_statements row 'finalized'
//     (idempotent — already-finalized rows are no-ops).
//   - Returns a summary JSON: { period, finalized: <row-or-null> }.
//
// Actually invoicing the studio (Stripe invoice or Resend email) is
// deferred to a follow-up commit — the source prompt says (optional
// phase 2). Leaving finalize-only here means the statement is frozen
// so any correction after month-close is a manual admin action.

import { finalizeMonth, priorPeriodChicago } from '../../lib/freeflow-billing.js';

function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams.get('secret');
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return q === secret || bearer === secret;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ error: 'unauthorized' });
  const period = priorPeriodChicago();
  try {
    const row = await finalizeMonth(period);
    return res.status(200).json({ ok: true, period, finalized: row });
  } catch (e) {
    console.error('[cron/freeflow-billing] failed:', e.message);
    return res.status(500).json({ ok: false, period, error: e.message });
  }
}
