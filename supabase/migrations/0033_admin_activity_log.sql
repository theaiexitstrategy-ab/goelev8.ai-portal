-- Cross-product admin activity log. Lives in the PORTAL's own
-- Supabase project, NOT any single product's Supabase, so the log
-- survives every product's schema changes / database migrations /
-- swap-outs. Each row tags:
--   - actor_email:  who did it
--   - product_slug: which product it happened under (null for
--                   portal-wide actions like editing global settings)
--   - action:       stable short slug (e.g. 'send_sms', 'delete_participant')
--   - target_type + target_id: what the action operated on
--   - metadata:     freeform jsonb for extra context (recipient phone,
--                   before/after values, etc.)
--   - created_at:   timestamp
--
-- Reads are gated at RLS to platform admins. Writes go through the
-- service role from api/admin.js's logAdminAction() helper so RLS
-- doesn't block insert-from-anywhere.

create table if not exists public.admin_activity_log (
  id           uuid primary key default gen_random_uuid(),
  actor_email  text,
  product_slug text,
  action       text not null,
  target_type  text,
  target_id    text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists admin_activity_log_created_at_idx
  on public.admin_activity_log (created_at desc);
create index if not exists admin_activity_log_product_slug_idx
  on public.admin_activity_log (product_slug)
  where product_slug is not null;
create index if not exists admin_activity_log_action_idx
  on public.admin_activity_log (action);

alter table public.admin_activity_log enable row level security;

drop policy if exists admin_activity_log_admin_read on public.admin_activity_log;
create policy admin_activity_log_admin_read
  on public.admin_activity_log
  for select
  to authenticated
  using (
    (auth.jwt() ->> 'email') = 'ab@goelev8.ai'
    or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid())
  );
