-- Master admin: platform_admins table + helper.
-- A platform admin is the GoElev8.AI operator (e.g. ab@goelev8.ai).
-- They authenticate as a normal Supabase auth user, but the portal API
-- recognizes them via this table and grants them cross-tenant access via
-- the service-role server-side. Regular clients have no visibility into
-- this table at all (no policies → RLS denies all access by default).

create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
-- No policies. Only the service role (used by api/admin.js) can read/write.

create or replace function public.is_platform_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.platform_admins where user_id = uid);
$$;

-- Pause flag for billing override
alter table public.clients
  add column if not exists billing_paused boolean not null default false;

-- Seed ab@goelev8.ai as a platform admin if the auth user already exists.
-- If the user does not exist yet, create them in Supabase Auth dashboard
-- (Authentication → Users → Add user, email = ab@goelev8.ai), then re-run
-- this insert by hand:
--
--   insert into public.platform_admins (user_id, email)
--   select id, email from auth.users where email = 'ab@goelev8.ai'
--   on conflict do nothing;
--
insert into public.platform_admins (user_id, email)
select id, email from auth.users where email = 'ab@goelev8.ai'
on conflict do nothing;
