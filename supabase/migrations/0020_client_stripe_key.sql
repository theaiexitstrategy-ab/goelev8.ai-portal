-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Add per-client Stripe secret key for syncing sales from external Stripe accounts.
-- Only accessible via service_role (admin); never exposed to client-scoped queries.

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS stripe_secret_key text;

COMMENT ON COLUMN public.clients.stripe_secret_key IS
  'Client own Stripe secret key (sk_live_...) for syncing sales from their Stripe account into the portal.';
