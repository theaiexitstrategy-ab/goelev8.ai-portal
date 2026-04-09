-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- RLS migration: move all per-tenant policies from current_client_id()
-- to a direct client_users membership check.
--
-- Why:
--   current_client_id() proved fragile on mobile PWA sessions — its
--   result depends on Supabase auth.uid() returning a non-null value
--   inside a SECURITY DEFINER function AND on the Supabase Realtime
--   path honoring the same session context as normal REST queries.
--   Coach Kenny's mobile PWA would intermittently fail RLS checks
--   (queries returned zero rows) after the OS backgrounded and then
--   foregrounded the WebView, because the Realtime re-auth didn't
--   propagate cleanly through the function. Switching to a direct
--   client_id IN (SELECT client_id FROM client_users WHERE user_id
--   = auth.uid()) check dodges the function indirection entirely.
--
--   The leads_* policies were already migrated to this shape out of
--   band during debugging (that's why the desktop + PWA leads list
--   works today while bookings, messages, etc. are still on the
--   function path). This migration brings every other per-tenant
--   table into alignment so the rest of the app doesn't hit the
--   same intermittent-empty-results symptom later.
--
-- Scope of this migration:
--   Rewrites policies on:
--     contacts, bookings, messages, credit_ledger, connect_payments,
--     vapi_calls, push_subscriptions, client_events, clients
--   AND on leads (idempotent — recreates the client_users-shaped
--     policies already applied in production so source-of-truth
--     migrations match the live DB state).
--
--   Does NOT drop public.current_client_id() — the function is kept
--   so any external tooling that still references it (ad-hoc SQL
--   scripts, Edge Functions, other Supabase projects) doesn't break
--   at deploy time. After this migration ships and has been
--   monitored in production, a follow-up can drop the function.

-- Shared helper predicate, inlined per policy below:
--   client_id in (select client_id from public.client_users where user_id = auth.uid())

-- ============================================================
-- leads (source-of-truth match for the already-live policies)
-- ============================================================
drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()));

drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to authenticated
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- clients (a user can read their own client row via membership)
-- ============================================================
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select to authenticated
  using (id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- Per-tenant tables with full CRUD policies:
--   contacts, bookings, messages, credit_ledger, connect_payments
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['contacts','bookings','messages','credit_ledger','connect_payments']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format($f$create policy %I_select on public.%I
      for select to authenticated
      using (client_id in (select client_id from public.client_users where user_id = auth.uid()))$f$, t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format($f$create policy %I_insert on public.%I
      for insert to authenticated
      with check (client_id in (select client_id from public.client_users where user_id = auth.uid()))$f$, t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format($f$create policy %I_update on public.%I
      for update to authenticated
      using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
      with check (client_id in (select client_id from public.client_users where user_id = auth.uid()))$f$, t, t);

    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format($f$create policy %I_delete on public.%I
      for delete to authenticated
      using (client_id in (select client_id from public.client_users where user_id = auth.uid()))$f$, t, t);
  end loop;
end $$;

-- ============================================================
-- vapi_calls (select only — inserts come from service role webhook)
-- ============================================================
drop policy if exists vapi_calls_select on public.vapi_calls;
create policy vapi_calls_select on public.vapi_calls
  for select to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- push_subscriptions
-- ============================================================
drop policy if exists push_subs_select on public.push_subscriptions;
create policy push_subs_select on public.push_subscriptions
  for select to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()));

drop policy if exists push_subs_insert on public.push_subscriptions;
create policy push_subs_insert on public.push_subscriptions
  for insert to authenticated
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

drop policy if exists push_subs_delete on public.push_subscriptions;
create policy push_subs_delete on public.push_subscriptions
  for delete to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- client_events
-- ============================================================
drop policy if exists client_events_select on public.client_events;
create policy client_events_select on public.client_events
  for select to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- Leave public.current_client_id() in place for now. Once this
-- migration has baked in production and no out-of-band tooling
-- still references it, a follow-up migration can safely run:
--
--   drop function if exists public.current_client_id();
--
-- Audit before dropping:
--
--   select n.nspname || '.' || p.proname as fn,
--          pg_get_functiondef(p.oid)
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where pg_get_functiondef(p.oid) ilike '%current_client_id%'
--      and p.proname <> 'current_client_id';
--
--   select schemaname, tablename, policyname
--     from pg_policies
--    where qual ilike '%current_client_id%'
--       or with_check ilike '%current_client_id%';
-- ============================================================
