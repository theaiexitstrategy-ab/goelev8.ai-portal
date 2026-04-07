// Stripe Connect (Express) onboarding — creates an account and returns an onboarding link.
import { requireUser, methodGuard } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';
import { stripe } from '../../../lib/stripe.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  const { data: client } = await supabaseAdmin.from('clients').select('*').eq('id', ctx.clientId).single();
  let acctId = client.stripe_connected_account_id;

  if (!acctId) {
    const account = await stripe.accounts.create({
      type: 'express',
      email: ctx.user.email,
      business_profile: { name: client.name },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { client_id: client.id }
    });
    acctId = account.id;
    await supabaseAdmin.from('clients').update({ stripe_connected_account_id: acctId }).eq('id', client.id);
  }

  const link = await stripe.accountLinks.create({
    account: acctId,
    refresh_url: `${process.env.PORTAL_BASE_URL}/?connect=refresh`,
    return_url: `${process.env.PORTAL_BASE_URL}/?connect=done`,
    type: 'account_onboarding'
  });

  return res.status(200).json({ url: link.url });
}
