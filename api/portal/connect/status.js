import { requireUser, methodGuard } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';
import { stripe } from '../../../lib/stripe.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { data: client } = await supabaseAdmin.from('clients').select('stripe_connected_account_id').eq('id', ctx.clientId).single();
  if (!client?.stripe_connected_account_id) return res.status(200).json({ connected: false });
  try {
    const acct = await stripe.accounts.retrieve(client.stripe_connected_account_id);
    return res.status(200).json({
      connected: true,
      charges_enabled: acct.charges_enabled,
      payouts_enabled: acct.payouts_enabled,
      details_submitted: acct.details_submitted,
      account_id: acct.id
    });
  } catch (e) {
    return res.status(200).json({ connected: false });
  }
}
