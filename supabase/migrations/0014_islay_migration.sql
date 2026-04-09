-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Migration 0014: iSlay Studios migration + tiered feature system
--
-- Adds:
--   • conversion_label, business_name, vapi_assistant_id, tier columns to clients
--   • artist_inquiries table (iSlay-specific CRM)
--   • studio_bookings table (iSlay session tracking)
--   • RLS policies for new tables
--   • Updates islay-studios client config

-- ============================================================
-- Extend clients table
-- ============================================================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS business_name text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS conversion_label text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS vapi_assistant_id text;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tier text NOT NULL DEFAULT 'starter';

-- Set existing clients
UPDATE clients SET
  business_name = 'iSlay Studios LLC',
  conversion_label = 'Artist Conversions',
  tier = 'custom'
WHERE slug = 'islay-studios';

UPDATE clients SET
  business_name = 'The Flex Facility LLC',
  conversion_label = 'Member Conversions',
  tier = 'custom'
WHERE slug = 'flex-facility';

-- ============================================================
-- artist_inquiries
-- ============================================================
CREATE TABLE IF NOT EXISTS public.artist_inquiries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  artist_name       text NOT NULL,
  artist_phone      text,
  artist_email      text,
  genre             text,
  service_interest  text,
  budget_range      text,
  status            text NOT NULL DEFAULT 'New',
  source            text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artist_inquiries_client
  ON public.artist_inquiries(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artist_inquiries_status
  ON public.artist_inquiries(client_id, status);
CREATE INDEX IF NOT EXISTS idx_artist_inquiries_phone
  ON public.artist_inquiries(client_id, artist_phone);

ALTER TABLE public.artist_inquiries ENABLE ROW LEVEL SECURITY;

CREATE POLICY artist_inquiries_select ON public.artist_inquiries
  FOR SELECT USING (client_id = public.current_client_id());
CREATE POLICY artist_inquiries_insert ON public.artist_inquiries
  FOR INSERT WITH CHECK (client_id = public.current_client_id());
CREATE POLICY artist_inquiries_update ON public.artist_inquiries
  FOR UPDATE USING (client_id = public.current_client_id());
CREATE POLICY artist_inquiries_delete ON public.artist_inquiries
  FOR DELETE USING (client_id = public.current_client_id());

-- ============================================================
-- studio_bookings
-- ============================================================
CREATE TABLE IF NOT EXISTS public.studio_bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  artist_inquiry_id   uuid REFERENCES public.artist_inquiries(id) ON DELETE SET NULL,
  artist_name         text NOT NULL,
  phone               text,
  email               text,
  service_type        text,
  session_date        timestamptz NOT NULL,
  duration_hours      decimal NOT NULL DEFAULT 1,
  rate_per_hour       decimal NOT NULL DEFAULT 0,
  total_amount        decimal NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'Confirmed',
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_bookings_client
  ON public.studio_bookings(client_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_studio_bookings_inquiry
  ON public.studio_bookings(artist_inquiry_id);
CREATE INDEX IF NOT EXISTS idx_studio_bookings_date
  ON public.studio_bookings(client_id, session_date);

ALTER TABLE public.studio_bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY studio_bookings_select ON public.studio_bookings
  FOR SELECT USING (client_id = public.current_client_id());
CREATE POLICY studio_bookings_insert ON public.studio_bookings
  FOR INSERT WITH CHECK (client_id = public.current_client_id());
CREATE POLICY studio_bookings_update ON public.studio_bookings
  FOR UPDATE USING (client_id = public.current_client_id());
CREATE POLICY studio_bookings_delete ON public.studio_bookings
  FOR DELETE USING (client_id = public.current_client_id());

-- ============================================================
-- Realtime publication for new tables
-- ============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['artist_inquiries', 'studio_bookings']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;
