-- Migration: Booking calendars + management tables for per-client booking pages.
-- Powers:
--   * public booking widget at book.<domain> (handled in flex-booking-calendar repo)
--   * portal Bookings tab at /theflexfacility/bookings (this repo)
--
-- Note: The user reports these tables already exist in the live Supabase
-- project (bnkoqybkmwtrlorhowyv). This file uses `create table if not exists`
-- and `on conflict do nothing` so it is safe to re-run and also gets the repo
-- migrations in sync with live state.
--
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/bnkoqybkmwtrlorhowyv/sql

-- ============================================================
-- booking_calendars — one per tenant (clients.id)
-- ============================================================
create table if not exists public.booking_calendars (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null references public.clients(id) on delete cascade,
  slug                text unique not null,
  custom_domain       text unique,
  title               text not null,
  timezone            text not null default 'America/Chicago',
  booking_window_days integer not null default 30,
  min_notice_hours    integer not null default 2,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists booking_calendars_business_idx on public.booking_calendars(business_id);

drop trigger if exists booking_calendars_touch on public.booking_calendars;
create trigger booking_calendars_touch before update on public.booking_calendars
for each row execute function public.touch_updated_at();

-- ============================================================
-- booking_services — bookable services per calendar
-- ============================================================
create table if not exists public.booking_services (
  id                uuid primary key default gen_random_uuid(),
  calendar_id       uuid not null references public.booking_calendars(id) on delete cascade,
  name              text not null,
  description       text,
  duration_minutes  integer not null default 30,
  price_cents       integer not null default 0,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists booking_services_calendar_idx on public.booking_services(calendar_id);

drop trigger if exists booking_services_touch on public.booking_services;
create trigger booking_services_touch before update on public.booking_services
for each row execute function public.touch_updated_at();

-- ============================================================
-- booking_availability — weekly recurring availability windows
-- One row per day_of_week the calendar is open.
-- day_of_week: 0=Sun, 1=Mon, ... 6=Sat (JS convention)
-- ============================================================
create table if not exists public.booking_availability (
  id           uuid primary key default gen_random_uuid(),
  calendar_id  uuid not null references public.booking_calendars(id) on delete cascade,
  day_of_week  smallint not null check (day_of_week between 0 and 6),
  start_time   time not null,
  end_time     time not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint booking_availability_time_order check (end_time > start_time)
);
create unique index if not exists booking_availability_calendar_day_uniq
  on public.booking_availability(calendar_id, day_of_week);

drop trigger if exists booking_availability_touch on public.booking_availability;
create trigger booking_availability_touch before update on public.booking_availability
for each row execute function public.touch_updated_at();

-- ============================================================
-- booking_appointments — actual bookings created by leads
-- status: pending | confirmed | cancelled | no_show
-- ============================================================
create table if not exists public.booking_appointments (
  id                uuid primary key default gen_random_uuid(),
  calendar_id       uuid not null references public.booking_calendars(id) on delete cascade,
  service_id        uuid references public.booking_services(id) on delete set null,
  lead_name         text not null,
  lead_phone        text,
  lead_email        text,
  appointment_start timestamptz not null,
  appointment_end   timestamptz not null,
  status            text not null default 'pending'
    check (status in ('pending','confirmed','cancelled','no_show')),
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists booking_appointments_calendar_start_idx
  on public.booking_appointments(calendar_id, appointment_start desc);
create index if not exists booking_appointments_status_idx
  on public.booking_appointments(calendar_id, status);

drop trigger if exists booking_appointments_touch on public.booking_appointments;
create trigger booking_appointments_touch before update on public.booking_appointments
for each row execute function public.touch_updated_at();

-- ============================================================
-- Seed: The Flex Facility booking calendar + default service + availability
--
-- IMPORTANT: this migration does NOT create the clients row. The Flex
-- Facility tenant is created via scripts/onboard-client.mjs (preset
-- 'flex-facility') and already has its clients.id, Twilio number, Stripe
-- customer, and auth user linkage. The seeds below are no-ops unless the
-- 'flex-facility' client exists — run the onboarding script first if you
-- are applying this migration on a fresh Supabase project.
--
-- Note the naming distinction:
--   * clients.slug          = 'flex-facility'      (tenant key)
--   * booking_calendars.slug = 'the-flex-facility' (public URL slug,
--     used only as a fallback for book.goelev8.ai/<slug> — the real
--     public booking URL is custom_domain 'book.theflexfacility.com')
-- ============================================================

-- 1) Ensure the booking calendar row exists for the Flex tenant.
insert into public.booking_calendars
  (business_id, slug, custom_domain, title, timezone, booking_window_days, min_notice_hours, is_active)
select
  c.id,
  'the-flex-facility',
  'book.theflexfacility.com',
  'The Flex Facility',
  'America/Chicago',
  30,
  2,
  true
from public.clients c
where c.slug = 'flex-facility'
on conflict (slug) do nothing;

-- 2) Ensure at least one service exists (Free Fitness Consultation, 30 min, $0).
insert into public.booking_services
  (calendar_id, name, description, duration_minutes, price_cents, is_active)
select
  cal.id,
  'Free Fitness Consultation',
  'An introductory 30-minute consultation to discuss your fitness goals.',
  30,
  0,
  true
from public.booking_calendars cal
join public.clients c on c.id = cal.business_id
where c.slug = 'flex-facility'
  and not exists (
    select 1 from public.booking_services s where s.calendar_id = cal.id
  );

-- 3) Seed Mon–Fri 9:00–17:00 availability if none exists for this calendar.
insert into public.booking_availability (calendar_id, day_of_week, start_time, end_time, is_active)
select cal.id, d.dow, time '09:00', time '17:00', true
from public.booking_calendars cal
join public.clients c on c.id = cal.business_id
cross join (values (1),(2),(3),(4),(5)) as d(dow)
where c.slug = 'flex-facility'
  and not exists (
    select 1 from public.booking_availability a where a.calendar_id = cal.id
  )
on conflict (calendar_id, day_of_week) do nothing;

-- ============================================================
-- Row Level Security
--
-- Portal API endpoints use the service role (supabaseAdmin) which bypasses
-- RLS, so tenant scoping is enforced in application code via ctx.clientId.
-- These policies exist for defense-in-depth and to keep the tables safe if
-- they are ever read via an anon/authenticated key.
-- ============================================================
alter table public.booking_calendars    enable row level security;
alter table public.booking_services     enable row level security;
alter table public.booking_availability enable row level security;
alter table public.booking_appointments enable row level security;

-- booking_calendars: tenant can read/write their own calendar by business_id.
drop policy if exists booking_calendars_tenant_all on public.booking_calendars;
create policy booking_calendars_tenant_all on public.booking_calendars
  for all
  using      (business_id = public.current_client_id())
  with check (business_id = public.current_client_id());

-- booking_services / availability: access via calendar ownership.
drop policy if exists booking_services_tenant_all on public.booking_services;
create policy booking_services_tenant_all on public.booking_services
  for all
  using (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  )
  with check (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  );

drop policy if exists booking_availability_tenant_all on public.booking_availability;
create policy booking_availability_tenant_all on public.booking_availability
  for all
  using (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  )
  with check (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  );

-- booking_appointments: tenant can read + update (status changes) but NOT
-- delete. Inserts come from the public booking widget via an edge function
-- using the service role, so no tenant insert policy is needed here.
drop policy if exists booking_appointments_tenant_select on public.booking_appointments;
create policy booking_appointments_tenant_select on public.booking_appointments
  for select
  using (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  );

drop policy if exists booking_appointments_tenant_update on public.booking_appointments;
create policy booking_appointments_tenant_update on public.booking_appointments
  for update
  using (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  )
  with check (
    calendar_id in (
      select id from public.booking_calendars
      where business_id = public.current_client_id()
    )
  );
