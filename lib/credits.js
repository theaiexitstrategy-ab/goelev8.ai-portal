// Credit pack catalog. Single source of truth — kept in sync with the
// public calculator at goelev8.ai/smscalc (SmsCalcClient.tsx PACKS
// constant). Update both together if pricing changes.
//
// Fields:
//   priceCents   — what the customer pays at checkout
//   baseCredits  — included credits before bonus
//   bonusCredits — additional credits granted on top
//   credits      — TOTAL credits granted (baseCredits + bonusCredits)
//
// `credits` stays as the public field every consumer reads (Stripe
// webhook grants it, the credit_ledger debit references it, the UI
// shows it) so the bonus is transparent to existing code paths — no
// extra plumbing needed for the bonus to actually land in a tenant's
// balance. The base/bonus breakout is for display only (line item
// descriptions, receipts, the buy-credits modal).
export const PACKS = {
  starter: {
    id: 'starter', label: 'Starter',
    priceCents:   2500,
    baseCredits:  500,
    bonusCredits: 0,
    credits:      500,
    badge: null
  },
  growth: {
    id: 'growth', label: 'Growth',
    priceCents:   6000,
    baseCredits:  1500,
    bonusCredits: 200,
    credits:      1700,
    badge: '🔥 Most Popular'
  },
  pro: {
    id: 'pro', label: 'Pro',
    priceCents:   17500,
    baseCredits:  5000,
    bonusCredits: 1000,
    credits:      6000,
    badge: 'Best Value'
  },
  elite: {
    id: 'elite', label: 'Elite',
    priceCents:   30000,
    baseCredits:  10000,
    bonusCredits: 2500,
    credits:      12500,
    badge: null
  }
};

export function getPack(id) {
  return PACKS[id] || null;
}

// Cents-per-credit for a pack — useful for the per-SMS rate display
// the buy-credits UI shows. Computed at read time so adding a new
// pack doesn't drift from the table values.
export function ratePerCredit(pack) {
  if (!pack || !pack.credits) return null;
  return pack.priceCents / pack.credits;
}

// Resolve the "billing client" for SMS sending and credit operations.
// If the client row carries a parent_client_id (e.g. Will Power Fitness
// Factory points at The Flex Facility), the parent is the source of
// truth for both Twilio config (subaccount creds + phone number) and
// credit balance. Returns the original client when no parent is set.
//
// Always returns an object with at least { id, twilio_phone_number,
// twilio_subaccount_sid, twilio_auth_token, credit_balance } when the
// parent is reachable; falls back to the original client if the parent
// row was deleted (parent_client_id was set with ON DELETE SET NULL,
// so we don't expect this in practice).
//
// All lib/api SMS send call sites should call this before reading
// credit_balance or invoking twilioForClient.
export async function getBillingClient(supabaseAdmin, client) {
  if (!client) return client;
  if (!client.parent_client_id) return client;
  const { data: parent } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, business_name, twilio_phone_number, twilio_subaccount_sid, twilio_auth_token, credit_balance, billing_paused, welcome_sms_enabled')
    .eq('id', client.parent_client_id)
    .maybeSingle();
  return parent || client;
}
