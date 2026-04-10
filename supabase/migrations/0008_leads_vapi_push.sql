-- Leads, Vapi calls, push subscriptions, and Vapi-aware bookings.
-- Adds the tables needed by the /api/webhooks/vapi ingestion route and the
-- dashboard activity surfaces.

-- ============================================================
-- leads
-- ============================================================
create table if not exists public.leads (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  contact_id    uuid references public.contacts(id) on delete set null,
  vapi_call_id  uuid,                                  -- soft link, set after vapi_calls row exists
  name          text,
  phone         text,
  email         text,
  source        text not null default 'manual',        -- 'vapi' | 'web_form' | 'manual' | ...
  source_path   text,
  status        text not null default 'new',           -- 'new' | 'contacted' | 'qualified' | 'won' | 'lost'
  intent        text,                                  -- short label, e.g. 'membership_inquiry'
  notes         text,
  payload       jsonb not null default '{}'::jsonb,    -- raw upstream payload for audit
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists leads_client_idx       on public.leads(client_id, created_at desc);
create index if not exists leads_client_status_idx on public.leads(client_id, status);
create index if not exists leads_vapi_call_idx    on public.leads(vapi_call_id);

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
for each row execute function public.touch_updated_at();

-- ============================================================
-- vapi_calls
-- ============================================================
create table if not exists public.vapi_calls (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients(id) on delete cascade,
  contact_id        uuid references public.contacts(id) on delete set null,
  lead_id           uuid references public.leads(id) on delete set null,
  vapi_call_id      text unique,                       -- Vapi's own call id (idempotency key)
  assistant_id      text,
  phone_number_id   text,
  direction         text,                              -- 'inbound' | 'outbound'
  from_number       text,
  to_number         text,
  customer_number   text,
  status            text,                              -- 'queued'|'ringing'|'in-progress'|'ended'|'failed'
  ended_reason      text,
  started_at        timestamptz,
  ended_at          timestamptz,
  duration_seconds  integer,
  recording_url     text,
  transcript        text,
  summary           text,
  structured_data   jsonb not null default '{}'::jsonb,
  cost_cents        integer,
  payload           jsonb not null default '{}'::jsonb, -- raw end-of-call-report
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists vapi_calls_client_idx     on public.vapi_calls(client_id, created_at desc);
create index if not exists vapi_calls_contact_idx    on public.vapi_calls(contact_id);
create index if not exists vapi_calls_lead_idx       on public.vapi_calls(lead_id);

drop trigger if exists vapi_calls_touch on public.vapi_calls;
create trigger vapi_calls_touch before update on public.vapi_calls
for each row execute function public.touch_updated_at();

-- Backfill the leads.vapi_call_id FK now that vapi_calls exists.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'leads_vapi_call_id_fkey'
  ) then
    alter table public.leads
      add constraint leads_vapi_call_id_fkey
      foreign key (vapi_call_id) references public.vapi_calls(id) on delete set null;
  end if;
end $$;

-- ============================================================
-- bookings: extend with vapi-aware columns
-- ============================================================
alter table public.bookings
  add column if not exists source         text not null default 'manual',
  add column if not exists vapi_call_id   uuid references public.vapi_calls(id) on delete set null,
  add column if not exists lead_id        uuid references public.leads(id) on delete set null,
  add column if not exists ends_at        timestamptz,
  add column if not exists contact_name   text,
  add column if not exists contact_phone  text,
  add column if not exists contact_email  text;

create index if not exists bookings_source_idx on public.bookings(client_id, source);

-- ============================================================
-- push_subscriptions (Web Push for the PWA)
-- ============================================================
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  user_id       uuid references auth.users(id) on delete cascade,
  endpoint      text not null,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create unique index if not exists push_subscriptions_endpoint_uniq
  on public.push_subscriptions(endpoint);
create index if not exists push_subscriptions_client_idx
  on public.push_subscriptions(client_id);
create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions(user_id);

-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.leads              enable row level security;
alter table public.vapi_calls         enable row level security;
alter table public.push_subscriptions enable row level security;

-- Tenant-isolated select/insert/update/delete on the new tables.
-- Service role (used by webhooks) bypasses RLS automatically.
do $$
declare t text;
begin
  foreach t in array array['leads','vapi_calls','push_subscriptions']
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

-- ============================================================
-- Realtime publication
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['leads','vapi_calls']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
