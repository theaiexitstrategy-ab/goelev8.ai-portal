import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getPack } from '../../lib/credits.js';

// Disable Vercel body parsing — Stripe needs the raw body for signature verification
export const config = { api: { bodyParser: false } };

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const sig = req.headers['stripe-signature'];
  const buf = await rawBody(req);
  let event;
  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const clientId = session.metadata?.client_id;
        const packId = session.metadata?.pack;
        const pack = getPack(packId);
        if (clientId && pack) {
          await supabaseAdmin.rpc('add_credits', { p_client_id: clientId, p_amount: pack.credits });
          await supabaseAdmin.from('credit_ledger').insert({
            client_id: clientId,
            delta: pack.credits,
            reason: 'purchase',
            ref_id: session.payment_intent,
            pack: pack.id,
            amount_cents: pack.priceCents
          });
        }
        break;
      }
      case 'payment_intent.succeeded': {
        // Handles auto-reload off-session charges (metadata.auto_reload=true)
        const pi = event.data.object;
        if (pi.metadata?.auto_reload === 'true') {
          const clientId = pi.metadata.client_id;
          const pack = getPack(pi.metadata.pack);
          if (clientId && pack) {
            await supabaseAdmin.rpc('add_credits', { p_client_id: clientId, p_amount: pack.credits });
            await supabaseAdmin.from('credit_ledger').insert({
              client_id: clientId,
              delta: pack.credits,
              reason: 'auto_reload',
              ref_id: pi.id,
              pack: pack.id,
              amount_cents: pack.priceCents
            });
          }
        }
        break;
      }
      case 'account.updated': {
        // Stripe Connect account state changes — could update flags here if needed
        break;
      }
      // Connect: payments collected on behalf of clients via their connected account
      case 'charge.succeeded': {
        const charge = event.data.object;
        const connectAcct = event.account; // present when delivered for connected account
        if (connectAcct) {
          const { data: client } = await supabaseAdmin
            .from('clients').select('id').eq('stripe_connected_account_id', connectAcct).maybeSingle();
          if (client) {
            await supabaseAdmin.from('connect_payments').insert({
              client_id: client.id,
              stripe_payment_intent: charge.payment_intent,
              amount_cents: charge.amount,
              application_fee_cents: charge.application_fee_amount || 0,
              currency: charge.currency,
              status: charge.status,
              customer_email: charge.billing_details?.email,
              description: charge.description
            });
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('webhook handler error', err);
    return res.status(500).json({ error: 'handler_failure' });
  }
  return res.status(200).json({ received: true });
}
