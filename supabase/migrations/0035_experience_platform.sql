-- Generic experience-booking platform. Multi-tenant from day one —
-- tenant_id / client_id on every row + RLS gated by client_users.
-- Konquered Balance is tenant #1 but nothing in this migration is
-- KB-shaped; future experience tenants (mixology, private chef,
-- guided tours, etc.) share this same schema.

-- ============================================================
-- tenant_write_keys — auth for public-facing endpoints on tenant
-- funnel sites (konqueredkocktails.com and any future equivalent).
-- Portal issues a raw key at tenant setup, tenant funnel stores it
-- in an env var and sends as x-portal-write-key on every call to
-- /api/external/experience-* endpoints.
--
-- Only the sha256 of the raw key is stored — the raw value is
-- shown ONCE at generation time and must be recorded then. Rotation
-- creates a new row + revokes the old (revoked_at set).
--
-- allowed_origins locks CORS per key so an issued key can't be used
-- from an arbitrary site.
-- ============================================================
create table if not exists public.tenant_write_keys (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  key_hash        text not null unique,     -- sha256 hex of raw key
  key_prefix      text not null,            -- first 8 chars of raw key, for humans/logs
  label           text,
  allowed_origins text[] not null default '{}',
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  revoked_at      timestamptz
);
create index if not exists tenant_write_keys_client_idx on public.tenant_write_keys(client_id) where revoked_at is null;

alter table public.tenant_write_keys enable row level security;
drop policy if exists tenant_write_keys_admin_all on public.tenant_write_keys;
create policy tenant_write_keys_admin_all on public.tenant_write_keys
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

-- ============================================================
-- experience_bookings — the core row. One row per submission,
-- promoted through: lead → deposit_pending → confirmed → refunded.
-- Distinct from public.bookings (booking-calendar recurring services)
-- and from freeflow_bookings (per-tenant Free Flow schema kept for
-- backward compat) — experience_bookings is the go-forward generic
-- shape.
-- ============================================================
create table if not exists public.experience_bookings (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients(id) on delete cascade,
  lead_id                uuid references public.leads(id) on delete set null,

  status                 text not null default 'lead'
                         check (status in ('lead','deposit_pending','confirmed','refunded','cancelled')),

  -- experience selection
  experience_key         text,                -- stable id, e.g. 'kustom_mixology'
  experience_display     text,                -- human name, used in Stripe line-item

  -- event date/time
  event_starts_at        timestamptz,         -- always UTC in DB
  event_tz               text default 'America/Chicago',
  when_display           text,                -- human string ("Sat, Jul 26 at 7:00 PM")
  duration_min           int,
  guest_count            int,

  -- guest contact
  guest_name             text,
  guest_email            text,
  guest_phone            text,                -- E.164
  goal                   text,

  -- money
  deposit_cents          int,
  stripe_session_id      text,
  stripe_payment_intent  text,
  application_fee_cents  int,                 -- platform take (destination charge)

  -- source
  source                 text default 'external',
  source_url             text,

  -- lifecycle bookkeeping (idempotency for notifications)
  confirmation_sent_at   timestamptz,
  tenant_alert_sent_at   timestamptz,
  refunded_at            timestamptz,
  cancelled_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists experience_bookings_client_starts_idx  on public.experience_bookings(client_id, event_starts_at);
create index if not exists experience_bookings_client_status_idx  on public.experience_bookings(client_id, status);
create index if not exists experience_bookings_stripe_session_idx on public.experience_bookings(stripe_session_id) where stripe_session_id is not null;
create index if not exists experience_bookings_client_created_idx on public.experience_bookings(client_id, created_at desc);

alter table public.experience_bookings enable row level security;

drop policy if exists experience_bookings_admin_all on public.experience_bookings;
create policy experience_bookings_admin_all on public.experience_bookings
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

drop policy if exists experience_bookings_tenant_all on public.experience_bookings;
create policy experience_bookings_tenant_all on public.experience_bookings
  for all to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- experience_availability_rules — weekly recurring open windows
-- per tenant. Availability API returns dates × rules - blocks -
-- existing bookings. experience_key is nullable so a rule can apply
-- to all experiences (default) or just one.
-- ============================================================
create table if not exists public.experience_availability_rules (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients(id) on delete cascade,
  experience_key     text,                    -- null = all experiences
  day_of_week        int not null check (day_of_week between 0 and 6),
  start_time         time not null,
  end_time           time not null,
  slot_duration_min  int not null default 60,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists experience_avail_rules_client_idx on public.experience_availability_rules(client_id, active);

alter table public.experience_availability_rules enable row level security;
drop policy if exists experience_avail_rules_admin_all on public.experience_availability_rules;
create policy experience_avail_rules_admin_all on public.experience_availability_rules
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));
drop policy if exists experience_avail_rules_tenant_all on public.experience_availability_rules;
create policy experience_avail_rules_tenant_all on public.experience_availability_rules
  for all to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- experience_availability_blocks — explicit unavailable windows
-- (Stephen's OOO days, personal blocks). Subtracted from rules by
-- the availability API. Also implicitly blocked: any existing
-- confirmed / deposit_pending booking's [starts_at, starts_at +
-- duration_min] range.
-- ============================================================
create table if not exists public.experience_availability_blocks (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  reason      text,
  created_at  timestamptz not null default now()
);
create index if not exists experience_avail_blocks_client_range_idx on public.experience_availability_blocks(client_id, starts_at, ends_at);

alter table public.experience_availability_blocks enable row level security;
drop policy if exists experience_avail_blocks_admin_all on public.experience_availability_blocks;
create policy experience_avail_blocks_admin_all on public.experience_availability_blocks
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));
drop policy if exists experience_avail_blocks_tenant_all on public.experience_availability_blocks;
create policy experience_avail_blocks_tenant_all on public.experience_availability_blocks
  for all to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));
