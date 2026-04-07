// Returns billing summary: credit balance, ledger, recent connect payments
import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { PACKS } from '../../lib/credits.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;

  const [{ data: client }, { data: ledger }, { data: connect }] = await Promise.all([
    supabaseAdmin.from('clients').select('credit_balance, auto_reload_enabled, auto_reload_threshold, auto_reload_pack').eq('id', clientId).single(),
    sb.from('credit_ledger').select('*').eq('client_id', clientId).order('created_at', { ascending: false }).limit(50),
    sb.from('connect_payments').select('*').eq('client_id', clientId).order('created_at', { ascending: false }).limit(50)
  ]);

  // Usage this month
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const { count: sentThisMonth } = await sb
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('direction', 'outbound')
    .gte('created_at', monthStart.toISOString());

  return res.status(200).json({
    credit_balance: client.credit_balance,
    auto_reload: {
      enabled: client.auto_reload_enabled,
      threshold: client.auto_reload_threshold,
      pack: client.auto_reload_pack
    },
    sent_this_month: sentThisMonth || 0,
    packs: PACKS,
    ledger,
    connect_payments: connect
  });
}
