-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
-- Customer profile avatars.
--
-- Add avatar_url to leads so the customer profile slide-over (and the
-- leads list) can show a photo when one's been uploaded. NULL means
-- "render initials in a brand-tinted circle". Same pattern as
-- clients.logo_url — the column is just a text URL pointing either at
-- a Supabase Storage object or, as a fallback for tiny avatars, at a
-- base64 data: URL embedded inline.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS avatar_url text;
