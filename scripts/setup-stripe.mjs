#!/usr/bin/env node
// Creates the Stripe webhook endpoint pointing at portal.goelev8.ai.
// (The credit packs are charged via Checkout sessions with inline price_data,
//  so no Product/Price objects need to be pre-created.)
import 'dotenv/config';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const base = process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai';

console.log('→ Creating Stripe webhook endpoint…');
const endpoint = await stripe.webhookEndpoints.create({
  url: `${base}/api/stripe/webhook`,
  enabled_events: [
    'checkout.session.completed',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'account.updated',
    'charge.succeeded'
  ],
  connect: true
});
console.log('✓ Webhook created:', endpoint.id);
console.log('');
console.log('🔑 Add this to your Vercel env vars (and .env.local):');
console.log('   STRIPE_WEBHOOK_SECRET=' + endpoint.secret);
console.log('');
console.log('Also visit https://dashboard.stripe.com/settings/connect to grab your STRIPE_CONNECT_CLIENT_ID');
