import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';
import { stripe } from '../../../lib/stripe.js';
import { getPack } from '../../../lib/credits.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { pack: packId } = await readJson(req);
  const pack = getPack(packId);
  if (!pack) return res.status(400).json({ error: 'invalid_pack' });

  const { data: client } = await supabaseAdmin.from('clients').select('*').eq('id', ctx.clientId).single();
  if (!client) return res.status(500).json({ error: 'client_not_found' });

  // Ensure stripe customer exists
  let customerId = client.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: ctx.user.email,
      name: client.name,
      metadata: { client_id: client.id }
    });
    customerId = customer.id;
    await supabaseAdmin.from('clients').update({ stripe_customer_id: customerId }).eq('id', client.id);
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    payment_method_types: ['card'],
    payment_intent_data: {
      setup_future_usage: 'off_session',
      metadata: { client_id: client.id, pack: pack.id, credits: String(pack.credits) }
    },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: pack.priceCents,
        product_data: {
          name: `GoElev8 SMS — ${pack.label} Pack`,
          description: `${pack.credits} SMS credits`
        }
      }
    }],
    success_url: `${process.env.PORTAL_BASE_URL}/?credits=success`,
    cancel_url: `${process.env.PORTAL_BASE_URL}/?credits=cancel`,
    metadata: { client_id: client.id, pack: pack.id, credits: String(pack.credits) }
  });

  return res.status(200).json({ url: session.url });
}
