import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { stripe } from '../../lib/stripe.js';

export default async function handler(req, res) {
  const ctx = await requireUser(req, res); if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  // GET ?action=status
  if (action === 'status') {
    if (!methodGuard(req, res, ['GET'])) return;
    const { data: client } = await supabaseAdmin
      .from('clients').select('stripe_connected_account_id').eq('id', ctx.clientId).single();
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
    } catch { return res.status(200).json({ connected: false }); }
  }

  // POST ?action=start  → create/refresh Express onboarding link
  if (action === 'start') {
    if (!methodGuard(req, res, ['POST'])) return;
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

  // POST ?action=payment-link  → Checkout on the connected account, with platform fee
  if (action === 'payment-link') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { amount_cents, description, customer_email } = await readJson(req);
    if (!Number.isInteger(amount_cents) || amount_cents < 100) {
      return res.status(400).json({ error: 'invalid_amount' });
    }
    const { data: client } = await supabaseAdmin
      .from('clients').select('stripe_connected_account_id, name').eq('id', ctx.clientId).single();
    if (!client?.stripe_connected_account_id) return res.status(400).json({ error: 'connect_not_setup' });
    const feeBps = parseInt(process.env.PLATFORM_FEE_BPS || '290', 10);
    const fee = Math.round(amount_cents * feeBps / 10000);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amount_cents,
          product_data: { name: description || `${client.name} payment` }
        }
      }],
      payment_intent_data: {
        application_fee_amount: fee,
        metadata: { client_id: ctx.clientId }
      },
      success_url: `${process.env.PORTAL_BASE_URL}/?pay=success`,
      cancel_url: `${process.env.PORTAL_BASE_URL}/?pay=cancel`
    }, { stripeAccount: client.stripe_connected_account_id });
    return res.status(200).json({ url: session.url, application_fee_cents: fee });
  }

  return res.status(400).json({ error: 'unknown_action' });
}
