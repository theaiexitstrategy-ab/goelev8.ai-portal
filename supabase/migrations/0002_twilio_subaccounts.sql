-- Add per-client Twilio subaccount auth token storage
alter table public.clients
  add column if not exists twilio_auth_token text;
