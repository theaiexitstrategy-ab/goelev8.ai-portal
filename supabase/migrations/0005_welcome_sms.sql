-- Welcome SMS on inbound webhook events.
-- When a client_event arrives via /api/events?action=ingest with a phone
-- number, the portal will optionally send an automated welcome SMS using
-- the client's configured template.

alter table public.clients
  add column if not exists welcome_sms_enabled  boolean not null default false,
  add column if not exists welcome_sms_template text;

-- Sensible default for any client that doesn't have one yet.
update public.clients
   set welcome_sms_template = 'Hi {{first_name}}, thanks for reaching out to {{client_name}}! We got your info and will be in touch shortly. Reply STOP to opt out.'
 where welcome_sms_template is null;
