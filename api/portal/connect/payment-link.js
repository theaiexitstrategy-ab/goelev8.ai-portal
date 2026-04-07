// Generate a Stripe Checkout link on the client's connected account that
// charges THEIR customer and routes a platform fee back to GoElev8.
import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';
import { stripe } from '../../../lib/stripe.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { amount_cents, description, customer_email } = await readJson(req);
  if (!Number.isInteger(amount_cents) || amount_cents < 100) {
    return res.status(400).json({ error: 'invalid_amount' });
  }
  const { data: client } = await supabaseAdmin.from('clients').select('stripe_connected_account_id, name').eq('id', ctx.clientId).single();
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
