-- GoElev8.ai multi-tenant portal schema
-- Run this once in the Supabase SQL editor.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto";

-- ============================================================
-- Tables
-- ============================================================

-- Tenant root
create table if not exists public.clients (
  id                            uuid primary key default gen_random_uuid(),
  slug                          text unique not null,
  name                          text not null,
  twilio_phone_number           text unique,
  twilio_subaccount_sid         text,
  stripe_customer_id            text unique,
  stripe_connected_account_id   text unique,
  credit_balance                integer not null default 0,
  auto_reload_enabled           boolean not null default false,
  auto_reload_threshold         integer not null default 50,
  auto_reload_pack              text not null default 'growth',
  created_at                    timestamptz not null default now()
);

-- Maps Supabase auth users to a tenant
create table if not exists public.client_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  client_id  uuid not null references public.clients(id) on delete cascade,
  role       text not null default 'member',
  created_at timestamptz not null default now()
);
create index if not exists client_users_client_id_idx on public.client_users(client_id);

-- Contacts (CRM)
create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  name        text not null,
  phone       text not null,
  email       text,
  tags        text[] default '{}',
  source      text default 'manual',
  notes       text,
  opted_out   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contacts_client_idx on public.contacts(client_id);
create unique index if not exists contacts_client_phone_uniq on public.contacts(client_id, phone);

-- Bookings
create table if not exists public.bookings (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  contact_id  uuid references public.contacts(id) on delete set null,
  service     text not null,
  starts_at   timestamptz not null,
  status      text not null default 'scheduled',
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists bookings_client_idx on public.bookings(client_id);
create index if not exists bookings_starts_at_idx on public.bookings(client_id, starts_at);

-- SMS messages (both directions, threaded by contact)
create table if not exists public.messages (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients(id) on delete cascade,
  contact_id          uuid references public.contacts(id) on delete set null,
  direction           text not null check (direction in ('inbound','outbound')),
  body                text not null,
  segments            integer not null default 1,
  twilio_sid          text unique,
  status              text,
  to_number           text not null,
  from_number         text not null,
  error_code          text,
  credits_charged     integer not null default 0,
  created_at          timestamptz not null default now()
);
create index if not exists messages_client_idx on public.messages(client_id, created_at desc);
create index if not exists messages_contact_idx on public.messages(contact_id, created_at desc);

-- Credit ledger (every change to credit_balance should write a row)
create table if not exists public.credit_ledger (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  delta       integer not null,
  reason      text not null, -- 'purchase' | 'sms_send' | 'refund' | 'adjustment' | 'auto_reload'
  ref_id      text,          -- stripe payment_intent / twilio sid / etc
  pack        text,          -- 'starter' | 'growth' | 'pro' (for purchases)
  amount_cents integer,      -- payment amount for purchases
  created_at  timestamptz not null default now()
);
create index if not exists credit_ledger_client_idx on public.credit_ledger(client_id, created_at desc);

-- Connect (client's own Stripe) payments collected from THEIR customers,
-- recorded so the client can see revenue & platform fee in the dashboard.
create table if not exists public.connect_payments (
  id                    uuid primary key default gen_random_uuid(),
  client_id             uuid not null references public.clients(id) on delete cascade,
  stripe_payment_intent text unique,
  amount_cents          integer not null,
  application_fee_cents integer not null default 0,
  currency              text not null default 'usd',
  status                text,
  customer_email        text,
  description           text,
  created_at            timestamptz not null default now()
);
create index if not exists connect_payments_client_idx on public.connect_payments(client_id, created_at desc);

-- ============================================================
-- Helper: current user's client_id
-- ============================================================
create or replace function public.current_client_id()
returns uuid
language sql stable security definer
set search_path = public
as $$
  select client_id from public.client_users where user_id = auth.uid() limit 1;
$$;

-- ============================================================
-- Triggers
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before update on public.contacts
for each row execute function public.touch_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.clients          enable row level security;
alter table public.client_users     enable row level security;
alter table public.contacts         enable row level security;
alter table public.bookings         enable row level security;
alter table public.messages         enable row level security;
alter table public.credit_ledger    enable row level security;
alter table public.connect_payments enable row level security;

-- clients: a user can read their own client row
drop policy if exists clients_select on public.clients;
create policy clients_select on public.clients
  for select using (id = public.current_client_id());

-- client_users: user can see their own row
drop policy if exists client_users_select on public.client_users;
create policy client_users_select on public.client_users
  for select using (user_id = auth.uid());

-- Generic tenant-isolation policy generator for the per-tenant tables
do $$
declare t text;
begin
  foreach t in array array['contacts','bookings','messages','credit_ledger','connect_payments']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format($f$create policy %I_select on public.%I
      for select using (client_id = public.current_client_id())$f$, t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format($f$create policy %I_insert on public.%I
      for insert with check (client_id = public.current_client_id())$f$, t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format($f$create policy %I_update on public.%I
      for update using (client_id = public.current_client_id())$f$, t, t);

    execute format('drop policy if exists %I_delete on public.%I', t, t);
    execute format($f$create policy %I_delete on public.%I
      for delete using (client_id = public.current_client_id())$f$, t, t);
  end loop;
end $$;

-- Service role bypasses RLS automatically; webhooks use the service role key.

-- ============================================================
-- Atomic credit decrement (used by SMS send path)
-- ============================================================
create or replace function public.consume_credits(p_client_id uuid, p_amount integer)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare new_balance integer;
begin
  update public.clients
     set credit_balance = credit_balance - p_amount
   where id = p_client_id and credit_balance >= p_amount
   returning credit_balance into new_balance;
  if new_balance is null then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;
  return new_balance;
end $$;

create or replace function public.add_credits(p_client_id uuid, p_amount integer)
returns integer
language plpgsql security definer
set search_path = public
as $$
declare new_balance integer;
begin
  update public.clients
     set credit_balance = credit_balance + p_amount
   where id = p_client_id
   returning credit_balance into new_balance;
  return new_balance;
end $$;
