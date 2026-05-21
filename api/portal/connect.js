// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Stripe Connect — OAuth flow for Standard accounts.
//
// Tenants link their EXISTING personal Stripe account to the GoElev8
// platform by clicking 'Connect Stripe', getting redirected to
// Stripe's hosted authorize page, logging in with their own
// credentials, and approving the connection. Once approved, Stripe
// redirects them back to our /api/portal/connect?action=callback
// endpoint with an authorization code. We exchange that code for a
// stripe_user_id (their account id) which we store on
// clients.stripe_connected_account_id. From there, every charge on
// the platform can route money to the tenant's account while
// taking application_fee_amount for GoElev8.
//
// Required env (set in Vercel):
//   STRIPE_CLIENT_ID     — your platform's Connect client_id (Stripe
//                          Dashboard → Connect → Settings → "OAuth").
//                          Looks like ca_xxxxxxxxxxxx for live mode.
//   STRIPE_SECRET_KEY    — already in use elsewhere
//   PORTAL_BASE_URL      — already in use elsewhere
//
// The OAuth state parameter carries the tenant's client_id signed
// with HMAC-SHA256 (key = STRIPE_SECRET_KEY) so a forged callback
// can't link a stripe account to the wrong tenant. State has a 10
// minute TTL.
//
// Actions on this endpoint:
//   GET  ?action=status       — auth-required, returns connection state
//   POST ?action=start        — auth-required, returns Stripe OAuth URL
//   GET  ?action=callback     — Stripe-driven redirect; no portal auth
//                                (state HMAC proves the tenant identity)
//   POST ?action=payment-link — auth-required, Checkout on connected acct

import crypto from 'node:crypto';
import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { stripe } from '../../lib/stripe.js';

// ─── State signing helpers (CSRF protection for OAuth) ─────────
function stateSecret() {
  // STRIPE_SECRET_KEY is unique per env + already secret. Reusing it
  // as the HMAC key avoids needing yet another env var while keeping
  // state tokens unforgeable.
  return process.env.STRIPE_SECRET_KEY || 'unset';
}
function signState(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', stateSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}
function verifyState(state) {
  try {
    if (typeof state !== 'string' || !state.includes('.')) return null;
    const [b64, sig] = state.split('.');
    const expected = crypto.createHmac('sha256', stateSecret()).update(b64).digest('base64url');
    // Timing-safe compare to avoid leaking secret via response timing.
    if (sig.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch { return null; }
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  // ─── OAuth callback (no portal auth — Stripe redirects unauthenticated) ─
  // Comes back via GET. The signed state param + Supabase update prove
  // which tenant is linking which Stripe account. After exchanging
  // the code for a stripe_user_id, we redirect into the portal with
  // a ?connect=done flag so the SPA shows a welcome banner.
  if (action === 'callback') {
    if (req.method !== 'GET') return res.status(405).end();
    const code  = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const portalBase = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
    const back = (qs) => res.redirect(302, `${portalBase}/?${qs}`);

    // Stripe sends `error` + `error_description` when the user cancels
    // or declines on the authorize page.
    const stripeErr = url.searchParams.get('error');
    if (stripeErr) {
      return back(`connect=error&reason=${encodeURIComponent(stripeErr)}`);
    }
    if (!code || !state) return back('connect=error&reason=missing_params');

    const parsed = verifyState(state);
    if (!parsed) return back('connect=error&reason=invalid_state');
    if (!parsed.client_id) return back('connect=error&reason=invalid_state');
    if (typeof parsed.ts !== 'number' || Date.now() - parsed.ts > 10 * 60 * 1000) {
      return back('connect=error&reason=state_expired');
    }

    // Exchange the authorization code for the tenant's stripe_user_id.
    let tokenResp;
    try {
      tokenResp = await stripe.oauth.token({ grant_type: 'authorization_code', code });
    } catch (e) {
      return back(`connect=error&reason=${encodeURIComponent(e.message || 'oauth_token_failed')}`);
    }
    const stripeUserId = tokenResp?.stripe_user_id;
    if (!stripeUserId) return back('connect=error&reason=no_stripe_user_id');

    // Persist the linkage. We store ONLY the account id —
    // application_fee_amount + transfer_data.destination handle
    // charge routing; we never need the user's access_token long-term.
    const { error: updErr } = await supabaseAdmin.from('clients')
      .update({ stripe_connected_account_id: stripeUserId })
      .eq('id', parsed.client_id);
    if (updErr) return back(`connect=error&reason=${encodeURIComponent(updErr.message)}`);

    return back(`connect=done&account=${encodeURIComponent(stripeUserId)}`);
  }

  // Everything below requires the user to be authed into the portal.
  const ctx = await requireUser(req, res); if (!ctx) return;

  // ─── GET ?action=status ────────────────────────────────────────
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
        account_id: acct.id,
        // 'standard' for OAuth-linked accounts, 'express' for the
        // legacy flow. Surfacing this lets the SPA show the right
        // copy (e.g. "open dashboard" vs "continue onboarding").
        type: acct.type || 'standard',
        business_name: acct.business_profile?.name || acct.settings?.dashboard?.display_name || null,
        country: acct.country || null
      });
    } catch { return res.status(200).json({ connected: false }); }
  }

  // ─── POST ?action=start ─ build the Stripe OAuth authorize URL ─
  // Returns { url } to the SPA, which sets window.location.href to
  // that URL — the tenant lands on Stripe's hosted authorize page,
  // logs into THEIR existing Stripe account, and approves the
  // platform. Stripe redirects them back to ?action=callback above.
  if (action === 'start') {
    if (!methodGuard(req, res, ['POST'])) return;

    if (!process.env.STRIPE_CLIENT_ID) {
      return res.status(500).json({
        error: 'stripe_client_id_missing',
        detail: 'STRIPE_CLIENT_ID env var not set in Vercel. Get it from Stripe Dashboard → Connect → Settings → Integration (looks like ca_xxxxxxxxxxxx for live mode).'
      });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({
        error: 'stripe_env_missing',
        detail: 'STRIPE_SECRET_KEY is not set in Vercel env vars.'
      });
    }

    const portalBase  = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
    const redirectUri = `${portalBase}/api/portal/connect?action=callback`;
    const state       = signState({ client_id: ctx.clientId, ts: Date.now() });

    // Look up tenant email/name to prefill Stripe's authorize page.
    // Reduces friction — Will/Kenny/Nate land on the page with their
    // info already filled in for the matching existing Stripe account.
    const { data: client } = await supabaseAdmin
      .from('clients').select('business_name, name').eq('id', ctx.clientId).maybeSingle();
    const businessName = client?.business_name || client?.name || '';

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     process.env.STRIPE_CLIENT_ID,
      scope:         'read_write',
      state:         state,
      redirect_uri:  redirectUri
    });
    // Prefill what we know about the tenant — Stripe ignores fields
    // it doesn't recognize, so this is safe across SDK versions.
    if (ctx.user?.email) params.set('stripe_user[email]', ctx.user.email);
    if (businessName)    params.set('stripe_user[business_name]', businessName);

    const authorizeUrl = `https://connect.stripe.com/oauth/v2/authorize?${params.toString()}`;
    return res.status(200).json({ url: authorizeUrl, mode: 'oauth' });
  }

  // ─── POST ?action=disconnect ─ revoke the OAuth grant + clear the row
  // Operator-driven; tenants can hit this if they want to unlink
  // their Stripe account from the platform.
  if (action === 'disconnect') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { data: client } = await supabaseAdmin
      .from('clients').select('stripe_connected_account_id').eq('id', ctx.clientId).single();
    if (!client?.stripe_connected_account_id) {
      return res.status(200).json({ ok: true, already_disconnected: true });
    }
    try {
      await stripe.oauth.deauthorize({
        client_id: process.env.STRIPE_CLIENT_ID,
        stripe_user_id: client.stripe_connected_account_id
      });
    } catch (e) {
      // Already revoked / account deleted — non-fatal; still clear our row.
      console.warn('[connect] deauthorize warning:', e.message);
    }
    await supabaseAdmin.from('clients')
      .update({ stripe_connected_account_id: null })
      .eq('id', ctx.clientId);
    return res.status(200).json({ ok: true });
  }

  // ─── POST ?action=payment-link ─ Checkout on the connected account
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
