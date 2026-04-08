-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Lead enrichment columns used by the universal /api/webhooks/lead
-- endpoint and the /embed/track.js form-capture script.
--
-- - tags    text[]   auto-tagged from the source URL by the webhook
--                    handler. e.g. /fit -> {athlete}, /rs2 -> {lifestyle}
-- - funnel  text     short identifier of which funnel sent the lead
--                    ('fit', 'rs2', 'main', 'booking', 'sms', etc.)

alter table public.leads
  add column if not exists tags   text[] not null default '{}',
  add column if not exists funnel text;

create index if not exists leads_client_funnel_idx
  on public.leads (client_id, funnel);
create index if not exists leads_tags_gin
  on public.leads using gin (tags);
