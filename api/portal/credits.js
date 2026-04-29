import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { stripe } from '../../lib/stripe.js';
import { getPack } from '../../lib/credits.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  // ---------- internal: auto-reload trigger (service-role) ----------
  if (action === 'auto-reload-trigger') {
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
    const customer = await stripe.customers.retrieve(client.stripe_customer_id);
    let pmId = customer.invoice_settings?.default_payment_method;
    if (!pmId) {
      const pms = await stripe.paymentMethods.list({ customer: client.stripe_customer_id, type: 'card', limit: 1 });
      if (!pms.data[0]) return res.status(400).json({ error: 'no_payment_method' });
      pmId = pms.data[0].id;
    }
    try {
      const pi = await stripe.paymentIntents.create({
        amount: pack.priceCents,
        currency: 'usd',
        customer: client.stripe_customer_id,
        payment_method: pmId,
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

  const ctx = await requireUser(req, res); if (!ctx) return;

  // ---------- POST /api/portal/credits?action=checkout ----------
  if (action === 'checkout') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { pack: packId } = await readJson(req);
    const pack = getPack(packId);
    if (!pack) return res.status(400).json({ error: 'invalid_pack' });
    const { data: client } = await supabaseAdmin.from('clients').select('*').eq('id', ctx.clientId).single();
    if (!client) return res.status(500).json({ error: 'client_not_found' });
    let customerId = client.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: ctx.user.email, name: client.name, metadata: { client_id: client.id }
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
          product_data: { name: `GoElev8 SMS — ${pack.label} Pack`, description: `${pack.credits} SMS credits` }
        }
      }],
      success_url: `${process.env.PORTAL_BASE_URL}/?credits=success`,
      cancel_url: `${process.env.PORTAL_BASE_URL}/?credits=cancel`,
      metadata: { client_id: client.id, pack: pack.id, credits: String(pack.credits) }
    });
    return res.status(200).json({ url: session.url });
  }

  // ---------- POST /api/portal/credits?action=reconcile ----------
  // Recovers any paid Stripe checkout session for this tenant that didn't
  // get a corresponding credit_ledger entry (e.g. webhook didn't fire,
  // signing-secret mismatch, transient outage). Idempotent — safe to call
  // repeatedly. Auto-fires on the ?credits=success return URL.
  if (action === 'reconcile') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { data: client } = await supabaseAdmin
      .from('clients').select('id, stripe_customer_id, credit_balance').eq('id', ctx.clientId).single();
    if (!client?.stripe_customer_id) {
      return res.status(200).json({ recovered: 0, reason: 'no_stripe_customer' });
    }

    // Pull recent paid sessions for this Stripe customer (last 90 days)
    let sessions = [];
    try {
      const ninetyDaysAgo = Math.floor((Date.now() - 90 * 86400 * 1000) / 1000);
      const list = await stripe.checkout.sessions.list({
        customer: client.stripe_customer_id,
        limit: 50,
        created: { gte: ninetyDaysAgo }
      });
      sessions = list.data || [];
    } catch (e) {
      return res.status(200).json({ recovered: 0, error: e.message });
    }

    // Existing ledger ref_ids for this client (payment_intent ids on the row)
    const { data: existingLedger } = await supabaseAdmin
      .from('credit_ledger').select('ref_id').eq('client_id', client.id);
    const seenRefs = new Set((existingLedger || []).map(r => r.ref_id).filter(Boolean));

    let recovered = 0;
    let creditsAdded = 0;
    const recoveredItems = [];

    for (const s of sessions) {
      if (s.payment_status !== 'paid' || s.status !== 'complete') continue;
      const pi = s.payment_intent;
      if (!pi || seenRefs.has(pi)) continue;

      // Resolve the pack from session metadata first, then payment_intent metadata
      let packId = s.metadata?.pack;
      if (!packId) {
        try {
          const piObj = await stripe.paymentIntents.retrieve(pi);
          packId = piObj.metadata?.pack;
        } catch {}
      }
      const pack = getPack(packId);
      if (!pack) continue;

      // Apply credits + insert ledger row
      const { error: rpcErr } = await supabaseAdmin.rpc('add_credits', {
        p_client_id: client.id, p_amount: pack.credits
      });
      if (rpcErr) continue;
      const { error: ledErr } = await supabaseAdmin.from('credit_ledger').insert({
        client_id: client.id,
        delta: pack.credits,
        reason: 'purchase',
        ref_id: pi,
        pack: pack.id,
        amount_cents: pack.priceCents
      });
      if (ledErr) continue;

      recovered++;
      creditsAdded += pack.credits;
      recoveredItems.push({ pack: pack.id, credits: pack.credits, payment_intent: pi });
    }

    return res.status(200).json({ recovered, credits_added: creditsAdded, items: recoveredItems });
  }

  // ---------- POST /api/portal/credits?action=auto-reload ----------
  if (action === 'auto-reload') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { enabled, threshold, pack } = await readJson(req);
    if (pack && !getPack(pack)) return res.status(400).json({ error: 'invalid_pack' });
    const patch = {};
    if (typeof enabled === 'boolean') patch.auto_reload_enabled = enabled;
    if (Number.isInteger(threshold)) patch.auto_reload_threshold = threshold;
    if (pack) patch.auto_reload_pack = pack;
    const { data, error } = await supabaseAdmin.from('clients').update(patch).eq('id', ctx.clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ client: data });
  }

  return res.status(400).json({ error: 'unknown_action' });
}
