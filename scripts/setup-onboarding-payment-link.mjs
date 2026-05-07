// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-shot Stripe setup for the GoElev8.ai onboarding payment link.
//
// Creates (idempotently — safe to re-run):
//   • Product: "GoElev8.ai Onboarding & Setup" — one-time $400
//   • Product: "GoElev8.ai Growth Plan"        — recurring $99/month
//   • Coupon:  FOUNDING                         — 50% off onboarding only
//   • Payment Link: charges the discounted $200 setup + starts the
//     $99/mo subscription in one checkout. Auto-applies FOUNDING so
//     the customer sees the original $400 strike-through and the
//     -$200 discount line right at checkout.
//
// Run:
//   PowerShell:
//     $env:STRIPE_SECRET_KEY="sk_live_..."; node scripts/setup-onboarding-payment-link.mjs
//   Bash / zsh:
//     STRIPE_SECRET_KEY=sk_live_... node scripts/setup-onboarding-payment-link.mjs
//
// Prints the payment link URL to stdout when complete.

import Stripe from 'stripe';

const stripeKey = process.env.STRIPE_SECRET_KEY;
if (!stripeKey) {
  console.error('❌ Missing STRIPE_SECRET_KEY env var.');
  console.error('   Export it first:');
  console.error('     PowerShell: $env:STRIPE_SECRET_KEY="sk_live_..."');
  console.error('     Bash:       export STRIPE_SECRET_KEY=sk_live_...');
  process.exit(1);
}

const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

const ONBOARDING_NAME = 'GoElev8.ai Onboarding & Setup';
const GROWTH_NAME     = 'GoElev8.ai Growth Plan';
const COUPON_ID       = 'FOUNDING';
const REDIRECT_URL    = process.env.PORTAL_BASE_URL
  ? process.env.PORTAL_BASE_URL.replace(/\/$/, '') + '/?onboarding=done'
  : 'https://portal.goelev8.ai/?onboarding=done';

async function findOrCreateProduct(name, description) {
  // Stripe.products.search is the cleanest exact-name match.
  const list = await stripe.products.search({
    query: `name:'${name.replace(/'/g, "\\'")}' AND active:'true'`,
    limit: 5
  });
  if (list.data[0]) {
    console.log(`✓ Reusing existing product "${name}":`, list.data[0].id);
    return list.data[0];
  }
  const p = await stripe.products.create({ name, description });
  console.log(`+ Created product "${name}":`, p.id);
  return p;
}

async function findOrCreatePrice(product, fields, label) {
  const list = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = list.data.find(p =>
    p.unit_amount === fields.unit_amount &&
    p.currency    === fields.currency &&
    JSON.stringify(p.recurring || null) === JSON.stringify(fields.recurring || null)
  );
  if (match) {
    console.log(`✓ Reusing existing price (${label}):`, match.id);
    return match;
  }
  const created = await stripe.prices.create({ product: product.id, ...fields });
  console.log(`+ Created price (${label}):`, created.id);
  return created;
}

async function ensureCoupon(onboardingProductId) {
  let coupon = null;
  try {
    coupon = await stripe.coupons.retrieve(COUPON_ID);
  } catch (e) {
    if (e.code !== 'resource_missing') throw e;
  }

  // Stripe doesn't allow updating applies_to/percent_off on an existing
  // coupon. If the existing FOUNDING isn't bound to ONLY the onboarding
  // product (so the discount can't accidentally apply to the $99/mo
  // subscription), recreate it.
  const okShape = coupon
    && coupon.percent_off === 50
    && coupon.duration === 'once'
    && coupon.applies_to
    && Array.isArray(coupon.applies_to.products)
    && coupon.applies_to.products.length === 1
    && coupon.applies_to.products[0] === onboardingProductId;

  if (coupon && okShape) {
    console.log('✓ Reusing existing FOUNDING coupon (correctly scoped):', coupon.id);
    return coupon;
  }

  if (coupon) {
    console.log('  FOUNDING coupon exists but needs rebinding (deleting + recreating)…');
    await stripe.coupons.del(COUPON_ID);
  }

  coupon = await stripe.coupons.create({
    id: COUPON_ID,
    name: 'Founding Client Rate',
    percent_off: 50,
    duration: 'once',
    applies_to: { products: [onboardingProductId] }
  });
  console.log('+ Created coupon FOUNDING:', coupon.id);
  return coupon;
}

async function main() {
  console.log('🚀 Setting up GoElev8.ai onboarding payment link…\n');

  // 1. One-time onboarding product + $400 price
  const onboardingProduct = await findOrCreateProduct(
    ONBOARDING_NAME,
    'One-time onboarding and setup. Founding Client Rate: 50% off via the FOUNDING coupon brings $400 → $200.'
  );
  const onboardingPrice = await findOrCreatePrice(onboardingProduct, {
    unit_amount: 40000,           // $400.00 in cents
    currency: 'usd',
    nickname: 'Onboarding Setup — $400 (regular)'
  }, 'one-time $400');

  // 2. Recurring growth plan + $99/month price
  const growthProduct = await findOrCreateProduct(
    GROWTH_NAME,
    'Monthly subscription — full GoElev8.ai automation suite (lead capture, SMS blasts, nudges, analytics).'
  );
  const growthPrice = await findOrCreatePrice(growthProduct, {
    unit_amount: 9900,            // $99.00 in cents
    currency: 'usd',
    recurring: { interval: 'month' },
    nickname: 'Growth Plan — $99/month'
  }, 'recurring $99/mo');

  // 3. FOUNDING coupon — 50% off, scoped to onboarding product only.
  //    Scoping matters: without applies_to, the same 50% off would also
  //    discount the recurring subscription forever.
  const coupon = await ensureCoupon(onboardingProduct.id);

  // 4. Promotion code FOUNDING — Payment Links don't support an
  //    auto-applied `discounts` param (that's Checkout Sessions only),
  //    so we expose the coupon as a customer-typeable code.
  let promotionCode = null;
  {
    const existing = await stripe.promotionCodes.list({
      code: 'FOUNDING', active: true, limit: 1
    });
    promotionCode = existing.data[0] || null;
    if (promotionCode && promotionCode.coupon?.id !== coupon.id) {
      await stripe.promotionCodes.update(promotionCode.id, { active: false });
      promotionCode = null;
    }
  }
  if (!promotionCode) {
    promotionCode = await stripe.promotionCodes.create({
      coupon: coupon.id,
      code: 'FOUNDING',
      metadata: { flow: 'goelev8_onboarding_v1' }
    });
    console.log('+ Created promotion code FOUNDING:', promotionCode.id);
  } else {
    console.log('✓ Reusing existing promotion code FOUNDING:', promotionCode.id);
  }

  // 5. Payment link — both line items + a typeable FOUNDING code.
  //    Customer enters FOUNDING at checkout to see the $400 strike-
  //    through and -$200 discount line. Recurring stays at full
  //    price because the coupon is scoped to the onboarding product.
  const paymentLink = await stripe.paymentLinks.create({
    line_items: [
      { price: onboardingPrice.id, quantity: 1 },
      { price: growthPrice.id,     quantity: 1 }
    ],
    allow_promotion_codes: true,
    custom_text: {
      submit: { message: 'Use code FOUNDING at checkout for 50% off the $400 setup fee (Founding Client Rate).' }
    },
    after_completion: {
      type: 'redirect',
      redirect: { url: REDIRECT_URL }
    },
    metadata: { flow: 'goelev8_onboarding_v1' }
  });

  console.log('\n========================================');
  console.log('💳 PAYMENT LINK READY');
  console.log('========================================');
  console.log(paymentLink.url);
  console.log('========================================\n');

  console.log('Summary:');
  console.log('  Onboarding product:', onboardingProduct.id);
  console.log('  Onboarding price:  ', onboardingPrice.id, '($400 one-time)');
  console.log('  Growth product:    ', growthProduct.id);
  console.log('  Growth price:      ', growthPrice.id, '($99/month)');
  console.log('  FOUNDING coupon:   ', coupon.id, '(50% off onboarding only)');
  console.log('  FOUNDING promo:    ', promotionCode.id, '(typeable code at checkout)');
  console.log('  Payment link:      ', paymentLink.url);
  console.log('');
  console.log('  Without code:      $499.00 ($400 setup + $99 first month)');
  console.log('  With FOUNDING:     $299.00 ($200 setup + $99 first month)');
  console.log('  Recurring:         $99.00/month after');
  console.log('  Redirect after:    ', REDIRECT_URL);
  console.log('');
  console.log('  Customer flow: open the link → click "Add promotion code"');
  console.log('  → type FOUNDING → see -$200 discount applied → checkout.');
}

main().catch(err => {
  console.error('\n❌ FAILED:', err.message);
  if (err.raw) console.error('Stripe error:', err.raw.message);
  process.exit(1);
});
