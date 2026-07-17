// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// GET /api/freeflow/statement — current + past monthly statements for
// the Free Flow Fitness studio dashboard. Auth: either master admin OR
// the studio's own tenant login (client_users → clients where slug =
// 'freeflow-fitness-stl'). Also accepts an INTERNAL_API_KEY header for
// server-to-server reads (e.g. the freeflow admin dashboard on the
// funnel repo can hit this directly).
//
// Response: {
//   current: {period, base_fee_cents, total_bookings, billable_bookings,
//             overage_cents, total_cents, status},
//   history: [ same shape, newest first ]
// }

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { FREEFLOW_TENANT_SLUG, FREEFLOW_BASE_FEE_CENTS, FREEFLOW_FREE_QUOTA } from '../../lib/freeflow-billing.js';

function currentPeriodChicago() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;

  // Server-to-server bypass first — a funnel-side page or a scheduled
  // job fetches without a portal user session.
  const internalKey = req.headers['x-internal-api-key'];
  const allowInternal = internalKey && process.env.INTERNAL_API_KEY
                        && internalKey === process.env.INTERNAL_API_KEY;

  let allowed = allowInternal;
  if (!allowed) {
    const ctx = await requireUser(req, res, { requireClient: false });
    if (!ctx) return; // requireUser already responded
    if (ctx.isAdmin) allowed = true;
    else if (ctx.clientId) {
      const { data: c } = await supabaseAdmin
        .from('clients').select('slug').eq('id', ctx.clientId).maybeSingle();
      if (c?.slug === 'freeflow-fitness-stl') allowed = true;
    }
  }
  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  const now = currentPeriodChicago();
  const { data: rows, error } = await supabaseAdmin
    .from('freeflow_billing_statements')
    .select('*')
    .eq('tenant_slug', FREEFLOW_TENANT_SLUG)
    .order('period', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const list = rows || [];
  let current = list.find((r) => r.period === now);
  const history = list.filter((r) => r.period !== now);

  // If there's no statement row for the current period yet (no
  // bookings have counted this month), surface an empty placeholder
  // so the dashboard can render the base-fee-only state rather than
  // "no data".
  if (!current) {
    current = {
      tenant_slug:       FREEFLOW_TENANT_SLUG,
      period:            now,
      base_fee_cents:    FREEFLOW_BASE_FEE_CENTS,
      free_quota:        FREEFLOW_FREE_QUOTA,
      total_bookings:    0,
      billable_bookings: 0,
      overage_cents:     0,
      total_cents:       FREEFLOW_BASE_FEE_CENTS,
      status:            'open',
      _placeholder:      true
    };
  }

  return res.status(200).json({ current, history });
}
