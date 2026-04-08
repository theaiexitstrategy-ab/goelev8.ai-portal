-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Add per-client branding fields so the portal header shows each
-- client's own logo + accent color when impersonating / when a regular
-- client signs in. Falls back to the GoElev8.AI mark when null.

alter table public.clients
  add column if not exists logo_url    text,
  add column if not exists brand_color text;

-- No data backfill: defaults to null, the portal renders the GoElev8
-- logo until you upload a per-client logo to Supabase storage and
-- update clients.logo_url to its public URL.
--
-- Suggested workflow once you have a logo file:
--
--   1. Supabase dashboard → Storage → create bucket "client-logos"
--      (public, file size limit 1 MB).
--   2. Upload e.g. flex-facility.png and islay-studios.png.
--   3. update public.clients
--        set logo_url = 'https://<project>.supabase.co/storage/v1/object/public/client-logos/flex-facility.png',
--            brand_color = '#0a0a0a'
--      where slug = 'flex-facility';
