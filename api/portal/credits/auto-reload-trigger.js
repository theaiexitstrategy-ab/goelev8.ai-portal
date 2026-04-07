// Internal endpoint: triggers an off-session charge to top up credits.
// Called from messages.js after a low-balance event. Auth via service-role header.
import { stripe } from '../../../lib/stripe.js';
import { supabaseAdmin } from '../../../lib/supabase.js';
import { getPack } from '../../../lib/credits.js';
import { readJson } from '../../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (req.headers['x-internal'] !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { client_id } = await readJson(req);
  const { data: client } = await supabaseAdmin.from('clients').select('*').eq('id', client_id).single();
  if (!client?.stripe_customer_id || !client.auto_reload_enabled) {
    return res.status(200).json({ skipped: true });
  }
  const pack = getPack(client.auto_reload_pack);
  if (!pack) return res.status(400).json({ error: 'invalid_pack' });

  // Find default payment method
  const customer = await stripe.customers.retrieve(client.stripe_customer_id);
  const pmId = customer.invoice_settings?.default_payment_method;
  if (!pmId) {
    // Try to grab any saved card
    const pms = await stripe.paymentMethods.list({ customer: client.stripe_customer_id, type: 'card', limit: 1 });
    if (!pms.data[0]) return res.status(400).json({ error: 'no_payment_method' });
  }
  try {
    const pi = await stripe.paymentIntents.create({
      amount: pack.priceCents,
      currency: 'usd',
      customer: client.stripe_customer_id,
      payment_method: pmId || (await stripe.paymentMethods.list({ customer: client.stripe_customer_id, type: 'card', limit: 1 })).data[0].id,
      off_session: true,
      confirm: true,
      description: `GoElev8 SMS auto-reload (${pack.label})`,
      metadata: { client_id, pack: pack.id, credits: String(pack.credits), auto_reload: 'true' }
    });
    return res.status(200).json({ ok: true, id: pi.id });
  } catch (err) {
    return res.status(402).json({ error: 'charge_failed', detail: err.message });
  }
}
