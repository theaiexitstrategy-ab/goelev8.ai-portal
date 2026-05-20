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
  //
  // Three paths, all wrapped in try/catch with descriptive errors so
  // a failure (missing env var, stale stripe_connected_account_id,
  // Stripe API rejection) surfaces a real reason instead of a silent
  // generic 500 the frontend can't translate.
  //
  //   1. No stripe_connected_account_id on file
  //      → create an Express account + accountLinks for onboarding
  //   2. Account exists, charges_enabled=true
  //      → return a login link to the Express dashboard
  //   3. Account exists, onboarding incomplete
  //      → re-create accountLinks for continued onboarding
  if (action === 'start') {
    if (!methodGuard(req, res, ['POST'])) return;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'stripe_env_missing',
        detail: 'STRIPE_SECRET_KEY is not set in Vercel env vars.' });
    }
    const portalBase = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');

    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients').select('id, name, business_name, stripe_connected_account_id')
      .eq('id', ctx.clientId).single();
    if (clientErr || !client) {
      return res.status(500).json({ error: 'client_lookup_failed', detail: clientErr?.message });
    }

    let acctId = client.stripe_connected_account_id;
    let acct = null;

    // If we have an account id on file, verify it still exists in
    // Stripe before reusing — a deleted/restricted account would
    // crash accountLinks.create with a confusing message.
    if (acctId) {
      try {
        acct = await stripe.accounts.retrieve(acctId);
      } catch (e) {
        // Stale id (account deleted in Stripe Dashboard, or wrong
        // mode key) — drop it and re-onboard.
        if (/No such account|does not exist|invalid/i.test(e.message || '')) {
          await supabaseAdmin.from('clients')
            .update({ stripe_connected_account_id: null }).eq('id', client.id);
          acctId = null;
        } else {
          return res.status(500).json({
            error: 'stripe_account_retrieve_failed',
            detail: e.message,
            account_id: acctId
          });
        }
      }
    }

    // Create a fresh Express account if needed.
    if (!acctId) {
      try {
        const account = await stripe.accounts.create({
          type: 'express',
          email: ctx.user.email,
          business_profile: { name: client.business_name || client.name || 'GoElev8 tenant' },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true }
          },
          metadata: { client_id: client.id }
        });
        acctId = account.id;
        acct = account;
        await supabaseAdmin.from('clients')
          .update({ stripe_connected_account_id: acctId }).eq('id', client.id);
      } catch (e) {
        return res.status(500).json({
          error: 'stripe_account_create_failed',
          detail: e.message
        });
      }
    }

    // If the account is fully onboarded, send them to the Express
    // dashboard instead of restarting onboarding.
    if (acct && acct.charges_enabled && acct.details_submitted) {
      try {
        const loginLink = await stripe.accounts.createLoginLink(acctId);
        return res.status(200).json({ url: loginLink.url, mode: 'dashboard' });
      } catch (e) {
        return res.status(500).json({
          error: 'stripe_login_link_failed',
          detail: e.message,
          account_id: acctId
        });
      }
    }

    // Otherwise return an onboarding link.
    try {
      const link = await stripe.accountLinks.create({
        account: acctId,
        refresh_url: `${portalBase}/?connect=refresh`,
        return_url:  `${portalBase}/?connect=done`,
        type: 'account_onboarding'
      });
      return res.status(200).json({ url: link.url, mode: 'onboarding', account_id: acctId });
    } catch (e) {
      return res.status(500).json({
        error: 'stripe_account_link_failed',
        detail: e.message,
        account_id: acctId,
        hint: /capability/i.test(e.message || '')
          ? 'Your platform account may not have Stripe Connect enabled — check Connect settings in your Stripe Dashboard.'
          : undefined
      });
    }
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
