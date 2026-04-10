-- Migration: Add tables needed for iSlay Studios portal integration
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/bnkoqybkmwtrlorhowyv/sql

-- ============================================================
-- Artists (per-client roster)
-- ============================================================
create table if not exists public.artists (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  name        text not null,
  specialty   text,
  booking_url text,
  photo_url   text,
  created_at  timestamptz not null default now()
);
create index if not exists artists_client_idx on public.artists(client_id);

-- ============================================================
-- Blasts (SMS blast campaigns)
-- ============================================================
create table if not exists public.blasts (
  id                uuid primary key default gen_random_uuid(),
  client_id         text not null,
  blast_name        text not null,
  message_body      text not null,
  sent_at           timestamptz not null default now(),
  total_recipients  integer not null default 0,
  delivered_count   integer not null default 0,
  failed_count      integer not null default 0,
  promo_code        text,
  target_segment    text default 'all',
  artist_filter     text,
  status            text not null default 'Sent',
  created_at        timestamptz not null default now()
);
create index if not exists blasts_client_idx on public.blasts(client_id, sent_at desc);

-- ============================================================
-- Client Settings (portal preferences per client)
-- ============================================================
create table if not exists public.client_settings (
  id                    uuid primary key default gen_random_uuid(),
  client_id             text unique not null,
  studio_name           text,
  owner_name            text,
  owner_email           text,
  owner_phone           text,
  promo_code            text,
  promo_amount          text,
  timezone              text default 'America/Chicago',
  notification_email    boolean not null default true,
  notification_sms      boolean not null default true,
  low_credit_threshold  integer not null default 20,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

drop trigger if exists client_settings_touch on public.client_settings;
create trigger client_settings_touch before update on public.client_settings
for each row execute function public.touch_updated_at();

-- ============================================================
-- Social Links (connected social accounts per client)
-- ============================================================
create table if not exists public.social_links (
  id          uuid primary key default gen_random_uuid(),
  client_id   text not null,
  platform    text not null,
  username    text,
  profile_url text,
  connected   boolean not null default false,
  followers   integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists social_links_client_platform_uniq
  on public.social_links(client_id, platform);

drop trigger if exists social_links_touch on public.social_links;
create trigger social_links_touch before update on public.social_links
for each row execute function public.touch_updated_at();

-- ============================================================
-- Credits (balance per client — used by islay-portal edge functions)
-- ============================================================
create table if not exists public.credits (
  id          uuid primary key default gen_random_uuid(),
  client_id   text unique not null,
  balance     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists credits_touch on public.credits;
create trigger credits_touch before update on public.credits
for each row execute function public.touch_updated_at();

-- Seed credit rows for existing clients (sync with clients.credit_balance)
insert into public.credits (client_id, balance)
  select slug, credit_balance from public.clients
  where slug not in (select client_id from public.credits)
on conflict (client_id) do nothing;

-- ============================================================
-- Credit Transactions (audit log for credit changes)
-- ============================================================
create table if not exists public.credit_transactions (
  id              uuid primary key default gen_random_uuid(),
  client_id       text not null,
  amount          integer not null,
  description     text,
  lead_id         uuid,
  bundle_type     text,
  cost_per_credit numeric,
  created_at      timestamptz not null default now()
);
create index if not exists credit_transactions_client_idx
  on public.credit_transactions(client_id, created_at desc);

-- ============================================================
-- Auto Reload settings (per client)
-- ============================================================
create table if not exists public.auto_reload (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 text unique not null,
  enabled                   boolean not null default false,
  threshold                 integer not null default 20,
  bundle_type               text not null default 'starter',
  stripe_payment_method_id  text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

drop trigger if exists auto_reload_touch on public.auto_reload;
create trigger auto_reload_touch before update on public.auto_reload
for each row execute function public.touch_updated_at();

-- ============================================================
-- Platform Admins (if not exists)
-- ============================================================
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ============================================================
-- Set Vapi assistant ID for iSlay Studios
-- ============================================================
update public.clients
  set vapi_assistant_id = 'a04cb686-85ce-4b37-b529-6f5dfb812edf'
  where slug = 'islay-studios';

-- ============================================================
-- RLS: enable on new tables, allow service role full access
-- ============================================================
alter table public.artists             enable row level security;
alter table public.blasts              enable row level security;
alter table public.client_settings     enable row level security;
alter table public.social_links        enable row level security;
alter table public.credits             enable row level security;
alter table public.credit_transactions enable row level security;
alter table public.auto_reload         enable row level security;
alter table public.platform_admins     enable row level security;

-- Anon/authenticated users can read their own data via current_client_id()
-- Service role bypasses RLS, so API routes using supabaseAdmin work automatically.
-- For portal pages using anon key, add select policies:
do $$
declare t text;
begin
  foreach t in array array['artists','blasts','client_settings','social_links','credits','credit_transactions','auto_reload']
  loop
    execute format('drop policy if exists %I_service_all on public.%I', t, t);
    execute format($f$create policy %I_service_all on public.%I
      for all using (true) with check (true)$f$, t, t);
  end loop;
end $$;
