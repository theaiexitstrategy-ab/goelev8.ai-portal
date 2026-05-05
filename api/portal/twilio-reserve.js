// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Twilio reserve summary + per-client breakdown.
//
// GET /api/portal/twilio-reserve
//   - Tenant context: returns this tenant's running balance + recent
//     reserve ledger rows.
//   - Admin (ab@goelev8.ai) without impersonation: returns the platform-
//     wide aggregate plus a per-client breakdown for the dashboard.

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res, { requireClient: false }); if (!ctx) return;

  const isPlatformAdmin = ctx.user?.email === 'ab@goelev8.ai';

  // Single-tenant view (any logged-in client, including admin while impersonating)
  if (ctx.clientId) {
    const { data: client } = await supabaseAdmin
      .from('clients')
      .select('id, name, business_name, twilio_reserve_cents')
      .eq('id', ctx.clientId).maybeSingle();
    const { data: ledger } = await supabaseAdmin
      .from('twilio_reserves').select('*')
      .eq('client_id', ctx.clientId)
      .order('created_at', { ascending: false }).limit(50);
    const reserves = ledger || [];
    const reserved_total = reserves
      .filter(r => r.delta_cents > 0)
      .reduce((s, r) => s + r.delta_cents, 0);
    const used_total = reserves
      .filter(r => r.delta_cents < 0)
      .reduce((s, r) => s + Math.abs(r.delta_cents), 0);
    return res.status(200).json({
      scope: 'tenant',
      client: client || null,
      balance_cents: client?.twilio_reserve_cents || 0,
      reserved_total_cents: reserved_total,
      used_total_cents: used_total,
      ledger: reserves
    });
  }

  // Platform-wide view (admin only, not impersonating)
  if (!isPlatformAdmin) return res.status(403).json({ error: 'forbidden' });

  const { data: clients } = await supabaseAdmin
    .from('clients').select('id, name, business_name, twilio_reserve_cents')
    .order('name');
  const totalBalance = (clients || []).reduce((s, c) => s + (c.twilio_reserve_cents || 0), 0);

  // Sum lifetime reserved + used across all clients for the platform header
  const { data: allLedger } = await supabaseAdmin
    .from('twilio_reserves').select('delta_cents');
  const reservedAll = (allLedger || []).filter(r => r.delta_cents > 0)
    .reduce((s, r) => s + r.delta_cents, 0);
  const usedAll = (allLedger || []).filter(r => r.delta_cents < 0)
    .reduce((s, r) => s + Math.abs(r.delta_cents), 0);

  return res.status(200).json({
    scope: 'platform',
    balance_cents: totalBalance,
    reserved_total_cents: reservedAll,
    used_total_cents: usedAll,
    by_client: (clients || []).map(c => ({
      id: c.id,
      name: c.business_name || c.name,
      balance_cents: c.twilio_reserve_cents || 0
    }))
  });
}
