-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Adds leads (CRM funnel), Vapi voice call logs, and PWA push subscriptions.
-- bookings table already exists from 0001_init.sql; we leave it untouched.

-- ============================================================
-- leads
-- ============================================================
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  source      text not null default 'manual',  -- 'Vapi' | 'Web Form' | 'manual' | ...
  status      text not null default 'New',     -- 'New' | 'Contacted' | 'Booked' | 'Lost'
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists leads_client_idx on public.leads(client_id, created_at desc);
create index if not exists leads_status_idx on public.leads(client_id, status);

alter table public.leads enable row level security;

drop policy if exists leads_select on public.leads;
create policy leads_select on public.leads
  for select using (client_id = public.current_client_id());
drop policy if exists leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert with check (client_id = public.current_client_id());
drop policy if exists leads_update on public.leads;
create policy leads_update on public.leads
  for update using (client_id = public.current_client_id());
drop policy if exists leads_delete on public.leads;
create policy leads_delete on public.leads
  for delete using (client_id = public.current_client_id());

-- ============================================================
-- vapi_calls
-- ============================================================
create table if not exists public.vapi_calls (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients(id) on delete cascade,
  caller_phone      text,
  duration_seconds  integer not null default 0,
  outcome           text,             -- 'Booked' | 'Voicemail' | 'Not Interested' | ...
  transcript        text,
  vapi_call_id      text,
  created_at        timestamptz not null default now()
);
create index if not exists vapi_calls_client_idx on public.vapi_calls(client_id, created_at desc);
create unique index if not exists vapi_calls_call_id_uniq
  on public.vapi_calls(client_id, vapi_call_id) where vapi_call_id is not null;

alter table public.vapi_calls enable row level security;

drop policy if exists vapi_calls_select on public.vapi_calls;
create policy vapi_calls_select on public.vapi_calls
  for select using (client_id = public.current_client_id());
-- Inserts from Vapi webhooks happen via service role; no end-user insert policy.

-- ============================================================
-- push_subscriptions (Web Push / PWA)
-- ============================================================
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete cascade,
  endpoint    text not null,
  p256dh      text,
  auth        text,
  user_agent  text,
  created_at  timestamptz not null default now(),
  unique (endpoint)
);
create index if not exists push_subs_client_idx on public.push_subscriptions(client_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists push_subs_select on public.push_subscriptions;
create policy push_subs_select on public.push_subscriptions
  for select using (client_id = public.current_client_id());
drop policy if exists push_subs_insert on public.push_subscriptions;
create policy push_subs_insert on public.push_subscriptions
  for insert with check (client_id = public.current_client_id());
drop policy if exists push_subs_delete on public.push_subscriptions;
create policy push_subs_delete on public.push_subscriptions
  for delete using (client_id = public.current_client_id());

-- ============================================================
-- Realtime publication: leads, bookings, vapi_calls
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['leads','bookings','vapi_calls']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
