// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Twilio reserve summary + per-client breakdown.
//
// GET /api/portal/twilio-reserve
//   - Tenant context: returns this tenant's running balance + recent
//     reserve ledger rows.
//   - Admin (ab@goelev8.ai) without impersonation: returns the platform-
//     wide aggregate plus a per-client breakdown for the dashboard.
//
// Returns setup_status so the UI can render a clear setup message
// instead of silent zeros when migration 0022 hasn't been applied:
//   'ok'              — column + table both present, data flowing
//   'no_purchases'    — schema in place but no purchases / sends yet
//   'column_missing'  — clients.twilio_reserve_cents not migrated
//   'table_missing'   — twilio_reserves ledger table not migrated

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const COL_MISSING_RE  = /column .*twilio_reserve_cents.* does not exist/i;
const TBL_MISSING_RE  = /(relation .*twilio_reserves.* does not exist|could not find the table .*twilio_reserves|table .*twilio_reserves.* does not exist)/i;

function emptyPayload(extra) {
  return {
    setup_status: 'column_missing',
    setup_message: 'Migration 0022 has not been applied yet — clients.twilio_reserve_cents column is missing. Click "Run Pending Migrations" or "Diagnose & Repair" in Master Admin to install it.',
    balance_cents: 0,
    reserved_total_cents: 0,
    used_total_cents: 0,
    ...(extra || {})
  };
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res, { requireClient: false }); if (!ctx) return;

  const isPlatformAdmin = ctx.user?.email === 'ab@goelev8.ai';

  // Single-tenant view (any logged-in client, including admin while impersonating)
  if (ctx.clientId) {
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients')
      .select('id, name, business_name, twilio_reserve_cents')
      .eq('id', ctx.clientId).maybeSingle();
    if (clientErr && COL_MISSING_RE.test(clientErr.message)) {
      return res.status(200).json(emptyPayload({ scope: 'tenant', client: null, ledger: [] }));
    }
    const { data: ledger, error: ledgerErr } = await supabaseAdmin
      .from('twilio_reserves').select('*')
      .eq('client_id', ctx.clientId)
      .order('created_at', { ascending: false }).limit(50);
    if (ledgerErr && TBL_MISSING_RE.test(ledgerErr.message || '')) {
      return res.status(200).json({
        ...emptyPayload({ scope: 'tenant', client: client || null, ledger: [] }),
        setup_status: 'table_missing',
        setup_message: 'Migration 0022 partially applied — twilio_reserves ledger table is missing. Click "Diagnose & Repair" in Master Admin.'
      });
    }
    const reserves = ledger || [];
    const reserved_total = reserves
      .filter(r => r.delta_cents > 0)
      .reduce((s, r) => s + r.delta_cents, 0);
    const used_total = reserves
      .filter(r => r.delta_cents < 0)
      .reduce((s, r) => s + Math.abs(r.delta_cents), 0);
    return res.status(200).json({
      scope: 'tenant',
      setup_status: reserves.length === 0 && (client?.twilio_reserve_cents || 0) === 0 ? 'no_purchases' : 'ok',
      client: client || null,
      balance_cents: client?.twilio_reserve_cents || 0,
      reserved_total_cents: reserved_total,
      used_total_cents: used_total,
      ledger: reserves
    });
  }

  // Platform-wide view (admin only, not impersonating)
  if (!isPlatformAdmin) return res.status(403).json({ error: 'forbidden' });

  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from('clients').select('id, name, business_name, twilio_reserve_cents')
    .order('name');
  if (clientsErr && COL_MISSING_RE.test(clientsErr.message)) {
    return res.status(200).json(emptyPayload({ scope: 'platform', by_client: [] }));
  }

  const totalBalance = (clients || []).reduce((s, c) => s + (c.twilio_reserve_cents || 0), 0);

  // Sum lifetime reserved + used across all clients for the platform header
  const { data: allLedger, error: ledgerErr } = await supabaseAdmin
    .from('twilio_reserves').select('delta_cents');
  if (ledgerErr && TBL_MISSING_RE.test(ledgerErr.message || '')) {
    return res.status(200).json({
      ...emptyPayload({
        scope: 'platform',
        by_client: (clients || []).map(c => ({
          id: c.id, name: c.business_name || c.name,
          balance_cents: c.twilio_reserve_cents || 0
        }))
      }),
      setup_status: 'table_missing',
      setup_message: 'Migration 0022 partially applied — twilio_reserves ledger table is missing. Click "Diagnose & Repair".'
    });
  }
  const reservedAll = (allLedger || []).filter(r => r.delta_cents > 0)
    .reduce((s, r) => s + r.delta_cents, 0);
  const usedAll = (allLedger || []).filter(r => r.delta_cents < 0)
    .reduce((s, r) => s + Math.abs(r.delta_cents), 0);

  const ledgerCount = (allLedger || []).length;
  return res.status(200).json({
    scope: 'platform',
    setup_status: ledgerCount === 0 && totalBalance === 0 ? 'no_purchases' : 'ok',
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
