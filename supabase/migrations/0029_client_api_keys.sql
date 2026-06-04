-- Per-client API keys for external sites posting into the portal
-- (e.g. willpowerfitnessfactory.com -> /api/external/lead).
--
-- Same shape as funnel_api_keys (funnel-subscribe pattern): the raw key
-- is shown to the operator exactly once at issue time, only its sha256
-- hash is stored. Bearer-token auth: the external endpoint hashes the
-- incoming Authorization header and looks the row up by key_hash.
--
-- A key is scoped to a single client_id; revoked_at lets the operator
-- kill it without deletion (preserves audit trail).

CREATE TABLE IF NOT EXISTS public.client_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['leads:write'],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS client_api_keys_client_id_idx
  ON public.client_api_keys (client_id);
CREATE INDEX IF NOT EXISTS client_api_keys_key_hash_idx
  ON public.client_api_keys (key_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.client_api_keys ENABLE ROW LEVEL SECURITY;

-- Only platform admins can manage keys through the API. The external
-- endpoint hits this table via the service-role key and bypasses RLS.
-- No client_users policy on purpose: keys are operator-issued, not
-- self-served by the client portal.
DROP POLICY IF EXISTS client_api_keys_admin_all ON public.client_api_keys;
CREATE POLICY client_api_keys_admin_all
  ON public.client_api_keys
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()
    )
  );
