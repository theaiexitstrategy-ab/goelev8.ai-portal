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
