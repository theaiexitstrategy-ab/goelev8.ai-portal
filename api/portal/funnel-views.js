// Funnel view stats endpoint — returns view count for the current month.
// GET /api/portal/funnel-views

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { count, error } = await supabaseAdmin
    .from('funnel_views')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .gte('viewed_at', startOfMonth);

  if (error) {
    // Table may not exist yet — return 0 gracefully
    return res.status(200).json({ count: 0 });
  }

  return res.status(200).json({ count: count || 0 });
}
