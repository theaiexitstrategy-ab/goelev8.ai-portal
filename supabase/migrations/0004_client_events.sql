-- Cross-project event ingestion table.
-- The GoElev8.AI portal Supabase project receives events from the
-- The-AI-Exit-Strategy Supabase project (and any client websites)
-- via the /api/events?action=ingest webhook. This table only stores
-- a denormalized copy for display in the portal — the source of truth
-- remains in The-AI-Exit-Strategy.

create table if not exists public.client_events (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  source          text not null,                 -- e.g. 'theflexfacility.com', 'islaystudiosllc.com'
  source_path     text,                          -- e.g. '/fit', '/r2s', '/contact'
  event_type      text not null,                 -- e.g. 'form_submission', 'booking', 'lead', 'signup'
  external_id     text,                          -- upstream id for idempotency
  contact_email   text,
  contact_phone   text,
  contact_name    text,
  title           text,                          -- short human label for list view
  payload         jsonb not null default '{}'::jsonb,
  occurred_at     timestamptz not null default now(),
  received_at     timestamptz not null default now(),
  unique (client_id, source, external_id)
);

create index if not exists client_events_client_occurred_idx
  on public.client_events (client_id, occurred_at desc);
create index if not exists client_events_type_idx
  on public.client_events (client_id, event_type);

alter table public.client_events enable row level security;

drop policy if exists client_events_select on public.client_events;
create policy client_events_select on public.client_events
  for select using (client_id = public.current_client_id());

-- Inserts only happen via the service role from the webhook endpoint.
-- No insert/update/delete policies for end users.

-- Make sure realtime publishes this table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_events'
  ) then
    execute 'alter publication supabase_realtime add table public.client_events';
  end if;
end $$;
