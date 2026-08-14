// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Shared platform-fee math. Used by both /api/external/fees.js (the
// fee-quote endpoint storefronts call before checkout) and
// /api/external/checkout.js (the ad-hoc Connect direct-charge
// endpoint). Single source of truth for:
//   - resolving the per-tenant percent (env default, per-row override)
//   - converting (amount, percent) → cents to charge as
//     application_fee_amount
//
// Keeping this in one file is what guarantees the quote the storefront
// shows the customer up front matches the application_fee_amount Stripe
// actually deducts at capture. If you change the math here, both
// endpoints get the new behavior automatically.

export const PLATFORM_FEE_DEFAULT_PCT = parseFloat(
  process.env.PLATFORM_FEE_DEFAULT_PCT || '10'
);

// Returns the percent (10 = 10%) to apply for this client. Reads
// clients.platform_fee_pct when set; falls back to the env default
// otherwise. Tolerant of legacy rows where the column doesn't exist.
export function resolvePlatformFeePct(client) {
  if (client && client.platform_fee_pct != null) {
    const p = parseFloat(client.platform_fee_pct);
    if (Number.isFinite(p) && p >= 0) return p;
  }
  return PLATFORM_FEE_DEFAULT_PCT;
}

// Compute the platform fee in cents. Math.round-to-whole-cents matches
// api/external/fees.js's historical behavior — the two endpoints must
// never disagree on the same (amount, pct) input.
export function calcPlatformFeeCents(amountCents, pct) {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0;
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.round(amountCents * pct / 100);
}

// ── Stripe pass-through ────────────────────────────────────────────
// Standard US Stripe pricing for online card charges. Override
// platform-wide via env if the account negotiated different rates.
// These now help determine what a customer is actually charged, so set
// them explicitly in Vercel rather than relying on these defaults.
export const STRIPE_FEE_PCT          = parseFloat(process.env.STRIPE_FEE_PCT || '2.9');
export const STRIPE_FEE_FIXED_CENTS  = parseInt(process.env.STRIPE_FEE_FIXED_CENTS || '30', 10);

// Gross up an amount so that, after Stripe takes its processing fee, the
// recipients are left with exactly targetReceivedCents. The surcharge
// formula: pre_fee / (1 - pct) + fixed.
//
//   target_received = what must survive Stripe
//   customer_total  = target_received + stripe_pass_through
//   stripe_fee      = customer_total × pct + fixed
//   ∴  customer_total = (target_received + fixed) / (1 - pct)
//
// Moved here from api/external/fees.js (where it was unexported) so the
// events flow computes the customer's price with the same arithmetic the
// fee-quote endpoint has always used. Behavior is unchanged — fees.js
// imports it now rather than keeping a private copy, which is the whole
// point of this file existing.
//
// Math.ceil means the customer is never undercharged by a rounding cent,
// so the recipient side is always >= target.
export function applyStripePassThrough(targetReceivedCents) {
  const pctFraction = STRIPE_FEE_PCT / 100;
  const customer = Math.ceil(
    (targetReceivedCents + STRIPE_FEE_FIXED_CENTS) / (1 - pctFraction)
  );
  const stripeFee = customer - targetReceivedCents;
  return { customer, stripeFee };
}

// Full price breakdown for one paid seat/ticket, under Stripe Connect
// DIRECT charges (the model api/external/checkout.js and
// experience-deposit.js already use, where the charge is created on the
// tenant's connected account and Stripe debits its fee from the tenant's
// balance).
//
// The requirement this encodes: the tenant nets exactly
// (100 − platform_fee_pct)% of list. That works out as:
//
//   customer pays        ceil((list + 30) / (1 - 0.029))   = 1061   on a $10 seat
//   Stripe takes                                    −61   from the tenant
//   application_fee                                −100   to GoElev8
//   tenant nets                                     900   = exactly 90%  ✓
//
// Note application_fee_amount is the PLATFORM FEE ONLY. Under direct
// charges the tenant already absorbs Stripe's cut — that's precisely what
// the customer surcharge is sized to cover — so routing the surcharge to
// the platform as well would take it twice and leave the tenant at $8.39.
// (Under a destination charge the platform pays Stripe, and the fee would
// instead be platform + stripe. Same economics, different split; don't mix
// the two halves of the two models.)
export function quoteEventSeat({
  listPriceCents,
  quantity = 1,
  platformFeePct,
  processingFeeCents = 0,
  passStripeFeesToCustomer = true
}) {
  const subtotal = Math.max(0, Math.floor(listPriceCents || 0)) * Math.max(1, Math.floor(quantity || 1));
  const platformFeeCents = calcPlatformFeeCents(subtotal, platformFeePct);
  const flatFee = Math.max(0, Math.floor(processingFeeCents || 0));

  // The tenant's share plus the platform's share both have to survive
  // Stripe, so the gross-up target is the whole subtotal + any flat fee.
  const target = subtotal + flatFee;

  let customerTotalCents, stripeFeeCents;
  if (passStripeFeesToCustomer) {
    const r = applyStripePassThrough(target);
    customerTotalCents = r.customer;
    stripeFeeCents     = r.stripeFee;
  } else {
    customerTotalCents = target;
    stripeFeeCents     = 0;   // tenant absorbs it out of their margin
  }

  const applicationFeeCents = platformFeeCents + flatFee;

  // What Stripe will actually debit from the tenant's balance on a direct
  // charge, computed from the final customer total. When the surcharge is
  // passed through this equals stripeFeeCents and the tenant lands on
  // exactly subtotal − platform_fee; when it ISN'T passed through the
  // tenant still pays Stripe out of their own margin, so the takehome is
  // genuinely lower. Deriving it here rather than assuming keeps
  // tenant_net_cents honest in both branches — the operator dashboard
  // shows this number as "you net".
  const stripeActualCents = Math.round(customerTotalCents * STRIPE_FEE_PCT / 100) + STRIPE_FEE_FIXED_CENTS;

  return {
    subtotal_cents:         subtotal,
    platform_fee_cents:     platformFeeCents,
    processing_fee_cents:   flatFee,
    stripe_fee_cents:       stripeFeeCents,
    customer_total_cents:   customerTotalCents,
    // Direct charge → platform fee only. See the note above.
    application_fee_cents:  applicationFeeCents,
    tenant_net_cents:       Math.max(0, customerTotalCents - stripeActualCents - applicationFeeCents)
  };
}
