-- Allow push_subscriptions without a client_id so platform admins
-- (who aren't tied to a single tenant) can subscribe to push.
alter table public.push_subscriptions
  alter column client_id drop not null;

-- Admin-aware RLS: admins can manage their own rows (client_id IS NULL).
drop policy if exists push_subs_select on public.push_subscriptions;
create policy push_subs_select on public.push_subscriptions
  for select using (
    client_id = public.current_client_id()
    or (client_id is null and user_id = auth.uid())
  );

drop policy if exists push_subs_insert on public.push_subscriptions;
create policy push_subs_insert on public.push_subscriptions
  for insert with check (
    client_id = public.current_client_id()
    or (client_id is null and user_id = auth.uid())
  );

drop policy if exists push_subs_delete on public.push_subscriptions;
create policy push_subs_delete on public.push_subscriptions
  for delete using (
    client_id = public.current_client_id()
    or (client_id is null and user_id = auth.uid())
  );
