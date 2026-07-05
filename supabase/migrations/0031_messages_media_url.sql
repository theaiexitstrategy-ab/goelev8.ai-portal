-- MMS support: track the attached-image URL on each message row so
-- both outbound MMS sends (portal composer + blasts) and inbound MMS
-- (Twilio webhook) can render inline in the message thread.
--
-- media_url: the publicly-viewable HTTPS URL of the attached image.
--            For outbound: our own Supabase Storage bucket (mms-attachments).
--            For inbound:  we re-host the Twilio-provided MediaUrl0 in
--                          the same bucket so the browser can display
--                          it without basic-auth to Twilio.
-- is_mms:    convenience flag so the UI + accounting can distinguish
--            MMS from SMS without inspecting media_url. Redundant with
--            (media_url IS NOT NULL) but explicit + cheap to index.
--
-- Both columns nullable so the migration is safe to apply against a
-- table with existing SMS-only history.
alter table if exists public.messages
  add column if not exists media_url text,
  add column if not exists is_mms    boolean default false;

-- Public storage bucket for MMS attachments. Mirrors the merch-images
-- bucket pattern: public so Twilio can fetch the URL when sending
-- outbound MMS, and so the browser can render the <img> inline in
-- both inbound and outbound message bubbles.
insert into storage.buckets (id, name, public)
  values ('mms-attachments', 'mms-attachments', true)
  on conflict (id) do nothing;
