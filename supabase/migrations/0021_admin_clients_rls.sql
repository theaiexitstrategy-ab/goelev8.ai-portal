-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
-- Enforce that only ab@goelev8.ai can SELECT the full clients list via a JWT
-- (tenant users keep seeing their own row via the pre-existing membership
-- policy). The admin API hits the clients table through supabaseAdmin which
-- uses the service_role key and bypasses RLS regardless — this migration
-- tightens the policy surface for the anon/authenticated roles so a leaked
-- JWT cannot enumerate tenants.

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

-- Drop the legacy "read all" policy if it exists under any common name.
DROP POLICY IF EXISTS clients_select_all     ON public.clients;
DROP POLICY IF EXISTS "clients are public"   ON public.clients;
DROP POLICY IF EXISTS clients_admin_select   ON public.clients;

-- Allow the platform admin (JWT email = ab@goelev8.ai) full SELECT.
CREATE POLICY clients_admin_select ON public.clients
  FOR SELECT
  TO authenticated
  USING (
    (auth.jwt() ->> 'email') = 'ab@goelev8.ai'
    OR EXISTS (
      SELECT 1 FROM public.platform_admins pa
      WHERE pa.user_id = auth.uid()
    )
  );

-- Tenant users keep seeing their own row via the membership policy. Recreate
-- defensively so a single SQL run is idempotent and self-contained.
DROP POLICY IF EXISTS clients_member_select  ON public.clients;
CREATE POLICY clients_member_select ON public.clients
  FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT client_id FROM public.client_users WHERE user_id = auth.uid()
    )
  );

-- Only platform admins can UPDATE / INSERT / DELETE via JWT; everything else
-- must go through the service-role admin API.
DROP POLICY IF EXISTS clients_admin_write ON public.clients;
CREATE POLICY clients_admin_write ON public.clients
  FOR ALL
  TO authenticated
  USING (
    (auth.jwt() ->> 'email') = 'ab@goelev8.ai'
    OR EXISTS (
      SELECT 1 FROM public.platform_admins pa
      WHERE pa.user_id = auth.uid()
    )
  )
  WITH CHECK (
    (auth.jwt() ->> 'email') = 'ab@goelev8.ai'
    OR EXISTS (
      SELECT 1 FROM public.platform_admins pa
      WHERE pa.user_id = auth.uid()
    )
  );
