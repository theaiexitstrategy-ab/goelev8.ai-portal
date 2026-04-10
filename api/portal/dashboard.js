// Dashboard summary endpoint — aggregates key stats for the client.

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  try {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 86400e3).toISOString();

    const [leadsRes, clientRes, callsRes] = await Promise.all([
      supabaseAdmin.from('leads').select('*').eq('client_id', clientId),
      supabaseAdmin.from('clients').select('credit_balance').eq('id', clientId).single(),
      supabaseAdmin.from('vapi_calls').select('id, created_at').eq('client_id', clientId)
    ]);

    const leads = leadsRes.data || [];
    const totalLeads = leads.length;
    let newThisWeek = 0, promoClaims = 0, bookingsConfirmed = 0, smsSent = 0, smsFailed = 0;

    for (const lead of leads) {
      if ((lead.date_entered || lead.created_at) >= oneWeekAgo) newThisWeek++;
      if (lead.promo_claimed) promoClaims++;
      if (lead.booking_confirmed) bookingsConfirmed++;
      if (lead.sms_delivered || lead.sms_status === 'sent') smsSent++;
      if (lead.sms_status === 'failed' || lead.sms_status === 'failed_no_credits') smsFailed++;
    }

    const callsThisMonth = (callsRes.data || []).filter(v => {
      const d = new Date(v.created_at);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;

    return res.status(200).json({
      totalLeads,
      newThisWeek,
      promoClaims,
      bookingsConfirmed,
      smsSent,
      smsFailed,
      creditBalance: clientRes.data?.credit_balance ?? 0,
      callsThisMonth
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
