// Credit pack catalog. Single source of truth.
export const PACKS = {
  starter: { id: 'starter', label: 'Starter', priceCents: 2500,  credits: 250  },
  growth:  { id: 'growth',  label: 'Growth',  priceCents: 5000,  credits: 625  },
  pro:     { id: 'pro',     label: 'Pro',     priceCents: 10000, credits: 2000 }
};

export function getPack(id) {
  return PACKS[id] || null;
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
