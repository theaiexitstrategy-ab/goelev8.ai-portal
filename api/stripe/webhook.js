import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getPack } from '../../lib/credits.js';
import { sendPushToClient, sendPushToAdmins } from '../../lib/push.js';

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

        // Credit pack purchase
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

        // Product sale — look up by metadata.client or stripe_connected_account_id
        const saleClientId = session.metadata?.client
          || session.metadata?.client_id;
        let resolvedClientId = saleClientId;

        // If no explicit client in metadata, try to match via connected account
        if (!resolvedClientId && event.account) {
          const { data: client } = await supabaseAdmin
            .from('clients').select('id').eq('stripe_connected_account_id', event.account).maybeSingle();
          if (client) resolvedClientId = client.id;
        }

        if (resolvedClientId && session.amount_total > 0) {
          // Look up product by stripe_price_id if available
          let productId = null;
          let productName = 'Product';
          const lineItems = session.line_items?.data || [];
          const priceId = lineItems[0]?.price?.id || session.metadata?.price_id;
          if (priceId) {
            const { data: product } = await supabaseAdmin
              .from('products')
              .select('id, name')
              .eq('client_id', resolvedClientId)
              .eq('stripe_price_id', priceId)
              .maybeSingle();
            if (product) {
              productId = product.id;
              productName = product.name;
            }
          }

          const amount = session.amount_total / 100;
          const saleData = {
            client_id: resolvedClientId,
            product_id: productId,
            stripe_session_id: session.id,
            amount,
            currency: session.currency || 'usd',
            customer_name: session.customer_details?.name,
            customer_email: session.customer_details?.email,
            customer_phone: session.customer_details?.phone,
            payment_status: 'paid',
            source: session.metadata?.source || 'direct'
          };

          const { data: sale } = await supabaseAdmin
            .from('sales').insert(saleData).select('id').single();

          if (sale) {
            await supabaseAdmin.from('sales_events').insert({
              sale_id: sale.id,
              event_type: 'created',
              metadata: { stripe_session_id: session.id }
            });
          }

          // GA4 server-side event (fire-and-forget)
          if (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET) {
            fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`, {
              method: 'POST',
              body: JSON.stringify({
                client_id: resolvedClientId,
                events: [{
                  name: 'purchase',
                  params: { value: amount, currency: session.currency || 'usd', transaction_id: session.id }
                }]
              })
            }).catch(() => {});
          }

          // Push notification to client + admin
          const saleDesc = `${productName} — $${amount.toFixed(2)}`;
          await Promise.all([
            sendPushToClient(resolvedClientId, 'New Sale!', saleDesc, '/sales'),
            sendPushToAdmins('💰 Sale — ' + (productName || 'Unknown'), saleDesc, '/sales')
          ]).catch(() => {});
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
      case 'payment_intent.payment_failed': {
        // Log failed payment to sales table
        const pi = event.data.object;
        const clientId = pi.metadata?.client || pi.metadata?.client_id;
        if (clientId) {
          const { data: sale } = await supabaseAdmin.from('sales').insert({
            client_id: clientId,
            amount: (pi.amount || 0) / 100,
            currency: pi.currency || 'usd',
            customer_email: pi.receipt_email,
            payment_status: 'failed',
            source: pi.metadata?.source || 'direct'
          }).select('id').single();

          if (sale) {
            await supabaseAdmin.from('sales_events').insert({
              sale_id: sale.id,
              event_type: 'failed',
              metadata: {
                payment_intent: pi.id,
                error: pi.last_payment_error?.message
              }
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
