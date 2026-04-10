-- Migration: Add iSlay-portal columns to leads table
-- The leads table keeps client_id as uuid (referencing clients.id).
-- We only need to add the extra columns the islay portal expects.

alter table public.leads
  add column if not exists full_name          text,
  add column if not exists artist_selected    text,
  add column if not exists lead_source        text,
  add column if not exists lead_status        text default 'New',
  add column if not exists date_entered       timestamptz,
  add column if not exists promo_code         text,
  add column if not exists promo_claimed      boolean default false,
  add column if not exists booking_url        text,
  add column if not exists booking_platform   text,
  add column if not exists booking_confirmed  boolean default false,
  add column if not exists sms_delivered      boolean default false,
  add column if not exists sms_status         text;
