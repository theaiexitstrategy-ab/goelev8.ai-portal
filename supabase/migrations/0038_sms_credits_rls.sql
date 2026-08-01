-- SECURITY FIX: public.sms_credits had RLS DISABLED prior to 2026-08-01.
-- Any client holding the anon key (i.e. every deployed storefront +
-- browser session) could read and write every tenant's credit balance.
-- Enable RLS with:
--   * Admin: full access (matches merch pattern)
--   * Tenant: SELECT only, scoped by matching the row's client_id text
--     (which is a slug on this table, not a uuid) to the caller's
--     client_users → clients.slug join
--   * Anon: no access (implicit — no policy)
--
-- No tenant WRITE policy — balance updates happen through portal admin
-- endpoints using the service role (which bypasses RLS). If any code
-- path was relying on anon writes, it will start failing after this
-- migration and MUST be moved to a service-role path.

ALTER TABLE public.sms_credits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_credits_admin_all ON public.sms_credits;
CREATE POLICY sms_credits_admin_all ON public.sms_credits
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()))
  WITH CHECK ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));

DROP POLICY IF EXISTS sms_credits_tenant_read ON public.sms_credits;
CREATE POLICY sms_credits_tenant_read ON public.sms_credits
  FOR SELECT TO authenticated
  USING (client_id IN (
    SELECT c.slug
      FROM public.clients c
      JOIN public.client_users cu ON cu.client_id = c.id
     WHERE cu.user_id = auth.uid()
  ));
