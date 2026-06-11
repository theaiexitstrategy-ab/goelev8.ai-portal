import { stripe } from '../../lib/stripe.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { getPack } from '../../lib/credits.js';
import { sendPushToClient, sendPushToAdmins } from '../../lib/push.js';
import { ingestExternalMerchOrder } from '../../lib/merch-ingest.js';

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

        // Portal-managed external checkout (api/external/checkout.js
        // direct-charge sessions from tenant storefronts like
        // islaystudiosllc.com/merch). Recognized by the source marker
        // on metadata. Writes a merch_orders row + line items so the
        // order shows up in the portal Merch → Orders tab. Idempotent
        // on stripe_payment_id so replays + backfills are safe.
        if (session.metadata?.source === 'portal_external_checkout') {
          try {
            await ingestExternalMerchOrder({ session, connectAccount: event.account });
          } catch (e) {
            console.error('[webhook] merch ingest failed:', e?.message);
          }
          break;
        }

        const clientId = session.metadata?.client_id;
        const packId = session.metadata?.pack;
        const pack = getPack(packId);

        // ─── GoElev8 onboarding flow auto-provision ─────────────────
        // When a FOUNDING-link checkout completes we read the
        // business_name + portal_slug custom fields, create a clients
        // row, invite the customer's email via Supabase auth (sends a
        // magic-link password-set email), and link them. Idempotent
        // by stripe_customer_id stored on the clients row.
        if (session.metadata?.flow === 'goelev8_onboarding_v1') {
          try {
            const fields = {};
            for (const f of (session.custom_fields || [])) {
              fields[f.key] = (f.text?.value || '').trim();
            }
            const businessName = fields.business_name || session.customer_details?.name || 'New Tenant';
            let slug = (fields.portal_slug || '').toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
            if (!slug) {
              slug = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
            }
            const customerEmail = session.customer_details?.email
              || session.customer_email || null;

            // Idempotency check: did we already create a tenant for
            // this Stripe customer?
            let { data: existing } = await supabaseAdmin
              .from('clients').select('id, slug')
              .eq('stripe_customer_id', session.customer || '').maybeSingle();

            if (!existing) {
              // Resolve a unique slug. If the requested one is taken,
              // append -2, -3, etc. until something free.
              let attempt = slug;
              for (let i = 2; i < 50; i++) {
                const { data: clash } = await supabaseAdmin
                  .from('clients').select('id').eq('slug', attempt).maybeSingle();
                if (!clash) break;
                attempt = `${slug}-${i}`;
              }
              slug = attempt;

              const { data: created, error: createErr } = await supabaseAdmin
                .from('clients').insert({
                  slug,
                  name: businessName,
                  business_name: businessName,
                  stripe_customer_id: session.customer || null,
                  credit_balance: 20,
                  welcome_sms_enabled: false
                })
                .select('id, slug').single();
              if (createErr) {
                console.error('[onboarding] client insert failed:', createErr.message);
              } else {
                existing = created;
                await supabaseAdmin.from('credit_ledger').insert({
                  client_id: created.id, delta: 20,
                  reason: 'trial_grant', ref_id: 'stripe_onboarding'
                });
              }
            }

            // Invite the customer by email — Supabase sends a magic
            // link they click to set their own password. Skipped
            // silently if email missing or auth API errors.
            if (existing && customerEmail) {
              const baseUrl = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
              const { data: invite, error: inviteErr } = await supabaseAdmin.auth.admin
                .inviteUserByEmail(customerEmail, {
                  redirectTo: `${baseUrl}/?welcome=1`,
                  data: { client_slug: existing.slug, business_name: businessName }
                });
              let userId = invite?.user?.id || null;
              if (inviteErr && /already|registered|exists/i.test(inviteErr.message)) {
                // User exists — find the id and just link them.
                const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
                userId = list?.users?.find(u => u.email === customerEmail)?.id || null;
              }
              if (userId) {
                const { data: link } = await supabaseAdmin.from('client_users')
                  .select('user_id').eq('user_id', userId).eq('client_id', existing.id).maybeSingle();
                if (!link) {
                  await supabaseAdmin.from('client_users').insert({
                    user_id: userId, client_id: existing.id, role: 'owner'
                  });
                }
              }
            }

            // Notify platform admins so we have visibility into new
            // signups in real time.
            await sendPushToAdmins('🎉 New GoElev8 tenant',
              `${businessName} just signed up at /${(existing?.slug || slug)}` +
              (customerEmail ? ` · ${customerEmail}` : ''),
              '/'
            ).catch(() => {});
          } catch (e) {
            console.error('[onboarding] auto-provision failed:', e.message);
          }
        }

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
          // Auto-reserve Twilio COGS — pack.credits × per-segment cost. So a
          // $25 / 250-credit Starter at 1¢/segment reserves $2.50 for Twilio
          // and leaves $22.50 of margin in the GoElev8 Stripe balance.
          // Tolerant if migration 0022 hasn't been applied yet.
          try {
            const perSeg = parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10);
            const reserveCents = Math.max(0, pack.credits * perSeg);
            await supabaseAdmin.rpc('adjust_twilio_reserve', {
              p_client_id: clientId,
              p_delta_cents: reserveCents,
              p_reason: 'pack_purchase',
              p_ref_id: session.payment_intent,
              p_pack: pack.id,
              p_segments: null,
              p_amount_cents: pack.priceCents
            });
          } catch (e) { /* migration not run — non-fatal */ }
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
            try {
              const perSeg = parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10);
              const reserveCents = Math.max(0, pack.credits * perSeg);
              await supabaseAdmin.rpc('adjust_twilio_reserve', {
                p_client_id: clientId,
                p_delta_cents: reserveCents,
                p_reason: 'pack_purchase',
                p_ref_id: pi.id,
                p_pack: pack.id,
                p_segments: null,
                p_amount_cents: pack.priceCents
              });
            } catch (e) { /* migration not run — non-fatal */ }
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
