-- Free Flow Fitness (Bridgeton, MO) — dedicated party/private-lesson
-- booking + Flow B usage-metering tables. Explicitly separate from the
-- shared bookings/leads tables per client requirement.
--
-- Wired end-to-end via:
--   POST /api/freeflow/bookings       intake (funnel or Vapi assistant)
--   POST /api/freeflow/stripe-webhook deposit-paid transition
--   lib/freeflow-billing.js           per-booking Flow B metering
--   GET  /api/freeflow/statement       studio dashboard read
--   cron /api/cron/freeflow-billing   monthly finalize
--
-- tenant_slug matches the funnel repo's naming convention verbatim
-- ('freeflow_fitness_stl', underscored) — distinct from the portal
-- clients.slug ('freeflow-fitness-stl', dash-cased) which follows
-- this repo's slug convention. Funnel POSTs the underscored form,
-- portal impersonates via the dashed slug. Both point at the same
-- physical tenant.

create table if not exists freeflow_bookings (
  id                     uuid primary key default gen_random_uuid(),
  tenant_slug            text not null default 'freeflow_fitness_stl',
  service_type           text not null check (service_type in ('party','private_lesson')),
  package_id             text,
  package_name           text,
  -- contact
  first_name             text not null,
  last_name              text not null,
  email                  text not null,
  phone                  text not null,                -- E.164 (+1XXXXXXXXXX)
  sms_consent            boolean not null default false,
  -- party details
  preferred_date         date,
  preferred_time         text,
  guest_count            int,
  occasion               text,
  dance_style            text,
  -- private-lesson details
  preferred_times        text,
  goals                  text,
  experience_level       text,
  notes                  text,
  -- money (deposit CHARGED TO CUSTOMER; null = inquiry-only hold)
  deposit_cents          int,
  stripe_session_id      text,
  payment_status         text not null default 'none'
                         check (payment_status in ('none','deposit_pending','deposit_paid','refunded')),
  -- lifecycle
  booking_status         text not null default 'new_request',
  confirmation_sms_sent  boolean not null default false,
  -- Flow B metering — has this booking been counted toward the
  -- studio's monthly usage?
  billing_counted        boolean not null default false,
  billing_period         text,                          -- 'YYYY-MM' the booking was counted in
  lead_source            text default 'freeflow_funnel',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index if not exists freeflow_bookings_created_at_idx
  on freeflow_bookings (created_at desc);
create index if not exists freeflow_bookings_billing_period_idx
  on freeflow_bookings (billing_period);
create index if not exists freeflow_bookings_stripe_session_idx
  on freeflow_bookings (stripe_session_id) where stripe_session_id is not null;

-- updated_at trigger: reuse the existing platform-wide helper if
-- present; otherwise fall back to inline row-update in the app layer.
-- The applyPendingMigrations runner creates set_updated_at() lazily
-- alongside other tables when needed — no new helper defined here to
-- avoid duplicating trigger fns.

alter table freeflow_bookings enable row level security;

drop policy if exists freeflow_bookings_admin_all on freeflow_bookings;
create policy freeflow_bookings_admin_all on freeflow_bookings
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

-- Tenant owner (Free Flow's future logged-in user) can read/write via
-- client_users link. Bookings are scoped by tenant_slug, but the RLS
-- gate joins to public.clients by slug so we don't need to add a
-- separate client_id column on freeflow_bookings.
drop policy if exists freeflow_bookings_tenant_all on freeflow_bookings;
create policy freeflow_bookings_tenant_all on freeflow_bookings
  for all to authenticated
  using (
    exists (
      select 1 from public.client_users cu
      join public.clients c on c.id = cu.client_id
      where cu.user_id = auth.uid()
        and c.slug = 'freeflow-fitness-stl'
    )
  )
  with check (
    exists (
      select 1 from public.client_users cu
      join public.clients c on c.id = cu.client_id
      where cu.user_id = auth.uid()
        and c.slug = 'freeflow-fitness-stl'
    )
  );

-- Monthly usage statements — Flow B billing. Studio owes $50/mo base
-- + $10 per booking after the first 5 in each YYYY-MM period.
create table if not exists freeflow_billing_statements (
  id                 uuid primary key default gen_random_uuid(),
  tenant_slug        text not null default 'freeflow_fitness_stl',
  period             text not null,                    -- 'YYYY-MM'
  base_fee_cents     int  not null default 5000,        -- $50/mo
  free_quota         int  not null default 5,
  total_bookings     int  not null default 0,
  billable_bookings  int  not null default 0,           -- max(0, total - free_quota)
  overage_cents      int  not null default 0,           -- billable * $10 (1000c each)
  total_cents        int  not null default 0,           -- base + overage
  status             text not null default 'open'
                     check (status in ('open','finalized','invoiced','paid')),
  stripe_invoice_id  text,
  finalized_at       timestamptz,
  invoiced_at        timestamptz,
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  unique (tenant_slug, period)
);

alter table freeflow_billing_statements enable row level security;

drop policy if exists freeflow_statements_admin_all on freeflow_billing_statements;
create policy freeflow_statements_admin_all on freeflow_billing_statements
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));
