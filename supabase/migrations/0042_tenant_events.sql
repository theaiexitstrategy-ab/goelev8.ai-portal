-- Paid event / seat reservations. Multi-tenant from day one — client_id
-- on every row + RLS gated by client_users, same shape as 0035.
--
-- WHY THIS IS NOT experience_bookings
-- -----------------------------------
-- experience_bookings models a PRIVATE slot claim: api/external/
-- experience-availability.js subtracts every confirmed / deposit_pending
-- booking from the tenant's open calendar. Seats at a published class are
-- a SHARED claim against one fixed offering — 30 people buy into the same
-- Saturday. Putting seats in experience_bookings would make the first
-- signup mark the slot busy and lock the other 29 out, and would blank the
-- tenant's real 1:1 availability for the event's duration. That's an
-- inversion of the availability semantics, not a variation on them.
--
-- The right analog is merch_products → merch_orders: a per-tenant catalog
-- row carrying the server-side price, plus one row per purchase. Named
-- tenant_events (not events) because client_events and sales_events
-- already exist and api/events.js is a different thing entirely.
--
-- Tenant #1 is The Flex Facility's ROQ N FLEX Bootcamp, seeded at the
-- bottom, but nothing here is flex-shaped.

-- ============================================================
-- tenant_events — the offering. One row per published event; every
-- reservation points at it. Keeping title / address / price / waiver
-- here (rather than denormalized onto each signup, the way
-- experience_bookings does it) is what lets an operator revise the
-- waiver or fix the venue once instead of rewriting N attendee rows.
-- ============================================================
create table if not exists public.tenant_events (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients(id) on delete cascade,

  event_key          text not null,               -- stable slug, e.g. 'roq-n-flex-bootcamp'
  title              text not null,
  description        text,

  status             text not null default 'draft'
                     check (status in ('draft','published','closed','cancelled')),

  -- when
  starts_at          timestamptz not null,        -- always UTC in DB
  event_tz           text not null default 'America/Chicago',
  duration_min       int,

  -- where
  location_name      text,
  address_line1      text,
  address_line2      text,
  city               text,
  state              text,
  postal_code        text,

  -- money. price_cents is the LIST price the customer sees advertised.
  -- The platform fee comes OUT of it (tenant nets list − fee); Stripe's
  -- processing is added ON TOP when pass_stripe_fees_to_customer, so the
  -- tenant nets exactly (100 − platform_fee_pct)% of list. See
  -- lib/platform-fee.js for the arithmetic.
  price_cents        int not null check (price_cents >= 0),
  currency           text not null default 'usd',

  -- Fee config, resolved most-specific-first:
  --   tenant_events.platform_fee_pct
  --   → clients.platform_fee_pct
  --   → PLATFORM_FEE_DEFAULT_PCT env (10)
  -- NULL here means "inherit", it does NOT mean zero.
  platform_fee_pct              numeric,
  -- Flat per-order platform fee. Deliberately defaults to 0, unlike
  -- merch's PROCESSING_FEE_DEFAULT_CENTS ($3) — a flat $3 on a $10 seat
  -- is a 30% surcharge and would have the customer paying $13.00.
  processing_fee_cents          int not null default 0 check (processing_fee_cents >= 0),
  pass_stripe_fees_to_customer  boolean not null default true,

  -- capacity. NULL = unlimited. seats_reserved is maintained ONLY by
  -- reserve_event_seats() / release_event_seats() below so the counter
  -- can't drift away from the rows.
  capacity           int check (capacity is null or capacity > 0),
  seats_reserved     int not null default 0 check (seats_reserved >= 0),

  -- waiver. waiver_text is the CURRENT canonical copy; each reservation
  -- snapshots whatever was live when that person accepted, so revising
  -- this column never rewrites history.
  waiver_required    boolean not null default false,
  waiver_version     text,
  waiver_text        text,

  image_url          text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (client_id, event_key)
);
create index if not exists tenant_events_client_status_idx on public.tenant_events(client_id, status);
create index if not exists tenant_events_client_starts_idx on public.tenant_events(client_id, starts_at desc);

alter table public.tenant_events enable row level security;

drop policy if exists tenant_events_admin_all on public.tenant_events;
create policy tenant_events_admin_all on public.tenant_events
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

drop policy if exists tenant_events_tenant_all on public.tenant_events;
create policy tenant_events_tenant_all on public.tenant_events
  for all to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- event_reservations — one row per seat purchase. Replaces
-- public.bootcamp_signups on the FLEX Supabase project (different
-- database entirely), which the marketing site writes today.
--
-- Column mapping from that table, for the backfill:
--   name             → attendee_name
--   phone            → attendee_phone   (normalized to E.164 on write)
--   email            → attendee_email
--   waiver_accepted  → waiver_accepted
--   stripe_session_id→ stripe_session_id
--   payment_status   → status ('paid' → 'confirmed', else 'pending')
--   client_id text   → client_id uuid   (resolved via clients.slug)
-- ============================================================
create table if not exists public.event_reservations (
  id                     uuid primary key default gen_random_uuid(),
  client_id              uuid not null references public.clients(id) on delete cascade,
  event_id               uuid not null references public.tenant_events(id) on delete cascade,
  lead_id                uuid references public.leads(id) on delete set null,

  status                 text not null default 'pending'
                         check (status in ('pending','confirmed','refunded','cancelled','expired')),

  -- attendee (public form input — validated on write, escaped on render)
  attendee_name          text not null,
  attendee_email         text,
  attendee_phone         text,                    -- E.164
  quantity               int not null default 1 check (quantity > 0),

  -- money, all snapshotted at purchase so a later price edit can't
  -- rewrite what somebody actually paid
  list_price_cents       int,                     -- tenant_events.price_cents at purchase
  amount_total_cents     int,                     -- what the customer was charged
  platform_fee_cents     int,                     -- GoElev8's cut
  stripe_fee_cents       int,                     -- pass-through surcharge added to the customer
  application_fee_cents  int,                     -- what we actually sent Stripe as application_fee_amount
  currency               text default 'usd',

  stripe_session_id      text unique,
  stripe_payment_intent  text,
  stripe_charge_id       text,
  receipt_url            text,
  -- Short opaque token behind /r/:token, which 302s to receipt_url. A raw
  -- Stripe receipt URL is 120+ chars and would be silently chopped into a
  -- dead link by lib/twilio.js truncateForSms()'s 160-char cap.
  receipt_token          text unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),

  -- Caller-supplied dedupe for the create call itself, so a double-submit
  -- or a retried proxy request returns the first reservation instead of
  -- holding a second seat. Stripe redelivery is handled separately, by the
  -- unique stripe_session_id above.
  idempotency_key        text,

  -- ── waiver provenance ────────────────────────────────────────────
  -- A version string alone proves WHICH revision, not WHAT IT SAID. The
  -- live copy is a real liability release that will be revised after
  -- attorney review, so each reservation carries its own snapshot of the
  -- text the participant actually saw, plus a hash for cheap
  -- "did all 40 of these people agree to identical copy" grouping.
  waiver_required        boolean not null default false,  -- snapshot of the event's flag
  waiver_accepted        boolean not null default false,
  waiver_version         text,
  waiver_text            text,
  waiver_text_sha256     text,
  waiver_accepted_at     timestamptz,
  waiver_ip              text,
  waiver_user_agent      text,

  -- lifecycle bookkeeping / notification idempotency
  paid_at                timestamptz,
  confirmation_sent_at   timestamptz,             -- guest SMS
  confirmation_email_sent_at timestamptz,         -- reserved; email deferred
  tenant_alert_sent_at   timestamptz,
  refunded_at            timestamptz,
  cancelled_at           timestamptz,

  source                 text default 'external',
  source_url             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Preserves the CHECK the FLEX table enforces (waiver_accepted = true),
  -- but survives an event that legitimately has no waiver. Because
  -- waiver_required is snapshotted onto the row, turning the flag off on
  -- the event later can never retroactively weaken an existing record.
  constraint event_reservations_waiver_ck
    check (waiver_required = false or waiver_accepted = true)
);
create index if not exists event_reservations_client_created_idx on public.event_reservations(client_id, created_at desc);
create index if not exists event_reservations_event_status_idx   on public.event_reservations(event_id, status);
create index if not exists event_reservations_pi_idx             on public.event_reservations(stripe_payment_intent) where stripe_payment_intent is not null;
-- Partial-unique so repeated NULLs stay legal but a given caller key can
-- only ever produce one reservation per tenant.
create unique index if not exists event_reservations_idem_idx
  on public.event_reservations(client_id, idempotency_key) where idempotency_key is not null;

alter table public.event_reservations enable row level security;

drop policy if exists event_reservations_admin_all on public.event_reservations;
create policy event_reservations_admin_all on public.event_reservations
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
         or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()))
  with check ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              or exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid()));

drop policy if exists event_reservations_tenant_all on public.event_reservations;
create policy event_reservations_tenant_all on public.event_reservations
  for all to authenticated
  using (client_id in (select client_id from public.client_users where user_id = auth.uid()))
  with check (client_id in (select client_id from public.client_users where user_id = auth.uid()));

-- ============================================================
-- reserve_event_seats — the ONLY way a reservation row is created.
-- Both the go-forward checkout endpoint and the ingest path for
-- already-collected payments call this, so seats_reserved can never
-- drift away from the rows that justify it.
--
-- Takes a row lock on the event before counting, which is what actually
-- prevents overselling: two concurrent buyers for the last seat serialize
-- here instead of both reading seats_reserved = capacity − 1.
--
-- p_status = 'confirmed' means the money is ALREADY collected (ingest /
-- backfill). In that case capacity is deliberately NOT enforced — a real
-- payment must never be refused a row just because the counter says the
-- room is full. Overbooking gets surfaced to the operator instead.
-- ============================================================
create or replace function public.reserve_event_seats(
  p_event_id            uuid,
  p_client_id           uuid,
  p_quantity            int,
  p_attendee_name       text,
  p_attendee_email      text default null,
  p_attendee_phone      text default null,
  p_waiver_accepted     boolean default false,
  p_waiver_version      text default null,
  p_waiver_text         text default null,
  p_waiver_text_sha256  text default null,
  p_waiver_ip           text default null,
  p_waiver_user_agent   text default null,
  p_idempotency_key     text default null,
  p_source              text default 'external',
  p_source_url          text default null,
  p_status              text default 'pending',
  p_stripe_session_id   text default null,
  p_list_price_cents    int default null,
  p_amount_total_cents  int default null,
  p_platform_fee_cents  int default null,
  p_stripe_fee_cents    int default null,
  p_application_fee_cents int default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event   public.tenant_events%rowtype;
  v_existing uuid;
  v_qty     int := greatest(1, coalesce(p_quantity, 1));
  v_taken   int;
  v_id      uuid;
begin
  -- Idempotency BEFORE the lock — a retry must not queue behind unrelated
  -- buyers, and must never consume a second seat.
  if p_idempotency_key is not null then
    select id into v_existing from public.event_reservations
     where client_id = p_client_id and idempotency_key = p_idempotency_key;
    if v_existing is not null then return v_existing; end if;
  end if;
  if p_stripe_session_id is not null then
    select id into v_existing from public.event_reservations
     where stripe_session_id = p_stripe_session_id;
    if v_existing is not null then return v_existing; end if;
  end if;

  select * into v_event from public.tenant_events
   where id = p_event_id and client_id = p_client_id
   for update;
  if not found then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  -- Capacity gate. Skipped for already-paid ingest, per the note above.
  if p_status <> 'confirmed' then
    if v_event.status <> 'published' then
      raise exception 'event_not_published' using errcode = 'P0001';
    end if;
    if v_event.capacity is not null then
      v_taken := v_event.seats_reserved;
      if v_taken + v_qty > v_event.capacity then
        raise exception 'sold_out' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- Waiver gate mirrors the table CHECK, but raises a named error the API
  -- can turn into a specific 4xx instead of a generic constraint violation.
  if v_event.waiver_required and not coalesce(p_waiver_accepted, false) then
    raise exception 'waiver_required' using errcode = 'P0001';
  end if;

  insert into public.event_reservations (
    client_id, event_id, status, attendee_name, attendee_email, attendee_phone,
    quantity, list_price_cents, amount_total_cents, platform_fee_cents,
    stripe_fee_cents, application_fee_cents, currency, stripe_session_id,
    idempotency_key, waiver_required, waiver_accepted, waiver_version,
    waiver_text, waiver_text_sha256, waiver_accepted_at, waiver_ip,
    waiver_user_agent, source, source_url, paid_at
  ) values (
    p_client_id, p_event_id, p_status, p_attendee_name, p_attendee_email, p_attendee_phone,
    v_qty, coalesce(p_list_price_cents, v_event.price_cents), p_amount_total_cents, p_platform_fee_cents,
    p_stripe_fee_cents, p_application_fee_cents, v_event.currency, p_stripe_session_id,
    p_idempotency_key, v_event.waiver_required, coalesce(p_waiver_accepted, false), p_waiver_version,
    p_waiver_text, p_waiver_text_sha256,
    case when coalesce(p_waiver_accepted, false) then now() else null end, p_waiver_ip,
    p_waiver_user_agent, p_source, p_source_url,
    case when p_status = 'confirmed' then now() else null end
  ) returning id into v_id;

  update public.tenant_events
     set seats_reserved = seats_reserved + v_qty, updated_at = now()
   where id = p_event_id;

  return v_id;
end;
$$;

-- Release seats held by an abandoned checkout. Constrained to rows still
-- pending so a late-arriving expiry event can't claw back a seat that was
-- paid for in the meantime.
create or replace function public.release_event_seats(p_stripe_session_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_reservations%rowtype;
begin
  update public.event_reservations
     set status = 'expired', updated_at = now()
   where stripe_session_id = p_stripe_session_id
     and status = 'pending'
   returning * into v_row;
  if not found then return false; end if;

  update public.tenant_events
     set seats_reserved = greatest(0, seats_reserved - v_row.quantity), updated_at = now()
   where id = v_row.event_id;
  return true;
end;
$$;

revoke all on function public.reserve_event_seats from public, anon, authenticated;
revoke all on function public.release_event_seats from public, anon, authenticated;
grant execute on function public.reserve_event_seats  to service_role;
grant execute on function public.release_event_seats to service_role;

-- ============================================================
-- Seed: The Flex Facility — ROQ N FLEX Bootcamp
-- ============================================================
-- NOTE ON waiver_text: left NULL on purpose. The live copy is the
-- liability release shipped in theflexfacility PR #33 and I don't have
-- its exact text from this repo. api/external/event-reservations.js
-- refuses with 409 waiver_not_configured when waiver_required is true and
-- waiver_text is NULL, so the flow cannot silently record an empty
-- waiver — paste the exact live copy into this row before cutover.
insert into public.tenant_events (
  client_id, event_key, title, description, status,
  starts_at, event_tz, duration_min,
  location_name, address_line1, city, state, postal_code,
  price_cents, capacity,
  waiver_required, waiver_version
)
select
  c.id,
  'roq-n-flex-bootcamp',
  'ROQ N FLEX Bootcamp',
  'Bootcamp session at The Flex Facility.',
  'published',
  timestamptz '2026-08-15 10:00:00-05:00',   -- Sat Aug 15 2026, 10:00 AM CDT
  'America/Chicago',
  60,
  'The Flex Facility',
  '4132 Shoreline Dr Ste 1',
  'Earth City',
  'MO',
  '63045',
  1000,        -- $10.00 list; customer pays $10.61, Kenny nets $9.00
  null,        -- capacity unknown — NULL is unlimited, set it in the portal
  true,
  'flex-bootcamp-2026-08-15-pr33'
from public.clients c
where c.slug = 'flex-facility'
on conflict (client_id, event_key) do nothing;

-- Surface the Events tab for the Flex Facility portal. Same per-client
-- portal_tabs jsonb mechanism as 0028. Idempotent.
update public.clients
set portal_tabs = portal_tabs || '["events"]'::jsonb
where slug = 'flex-facility'
  and portal_tabs is not null
  and not (portal_tabs ? 'events');
