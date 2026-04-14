-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Add lead_id linkage + thread-lookup indexes to public.messages.
--
-- Why: the Messages tab in the portal needs to display every SMS the
-- business has sent or received as a chat thread. We already had
-- contact_id, client_id, direction, body, status, twilio_sid, and the
-- to_number/from_number columns. Adding lead_id lets the welcome and
-- nudge sends carry the originating lead through, and gives the UI a
-- way to render lead names against threads that don't have a contacts
-- row yet.
--
-- The columns the prompt asks about are mapped to the existing schema:
--   sid       -> twilio_sid (already exists)
--   direction -> direction  (already exists, with check constraint)
--   lead_id   -> ADDED HERE
--
-- created_at + (client_id, created_at desc) index already exists from
-- 0001_init.sql; we add a per-direction phone-number index for the
-- Messages tab thread grouping (which keys off the OTHER party's
-- number, i.e. to_number for outbound and from_number for inbound).

alter table public.messages
  add column if not exists lead_id uuid references public.leads(id) on delete set null;

create index if not exists messages_lead_idx
  on public.messages(lead_id, created_at desc)
  where lead_id is not null;

-- Thread grouping lookups: most queries filter on client_id and then
-- group by the "other party" phone. These two indexes make the inbound
-- webhook's lead-by-from-number lookup and the Messages tab's thread
-- list both index-only.
create index if not exists messages_client_to_idx
  on public.messages(client_id, to_number, created_at desc);

create index if not exists messages_client_from_idx
  on public.messages(client_id, from_number, created_at desc);

-- nudge_queue carries the originating lead through to the cron worker
-- so when the delayed send finally fires it can persist lead_id onto
-- the messages row.
alter table public.nudge_queue
  add column if not exists lead_id uuid references public.leads(id) on delete set null;
