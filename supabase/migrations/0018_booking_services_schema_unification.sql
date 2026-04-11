-- Migration 0018: Unify booking schema between portal + public booking widget.
--
-- Background
-- ----------
-- Migration 0017 created booking_calendars/_services/_availability/_appointments
-- on the assumption that the public widget at book.theflexfacility.com (separate
-- repo: flex-booking-calendar) wrote into them. It does not — the widget writes
-- to the legacy public.bookings table (extended with lead_name/phone/email/source
-- by the widget's own migration), and renders its calendar from a hardcoded
-- SESSIONS object in flex-booking-calendar/index.html. The widget's repo also
-- created an `availability_templates` table marked "Part 9 — Portal calendar
-- management" that was seeded but never read by any code in either repo.
--
-- This migration unifies the schema so the portal can become the source of truth
-- for what services exist and when each service is bookable. Phase 2 (separate PR
-- in the widget repo) will refactor index.html to fetch from a new /api/services
-- endpoint instead of the hardcoded SESSIONS object.
--
-- Changes
-- -------
-- 1. DROP the unused booking_appointments / booking_availability / booking_services
--    tables from migration 0017 (all empty or seed-only, no live writers).
--    booking_calendars stays — it's still in use for the portal sidebar gating
--    and the booking-link widget at the top of the Bookings tab.
-- 2. CREATE a new public.booking_services table with the columns the widget's
--    SESSIONS object actually needs (key, name, full_name, btn_text, max_per_slot,
--    info_title, info_note, sort_order, is_active).
-- 3. ALTER public.availability_templates to add a service_id FK so each weekly
--    template row belongs to a specific service. Drops + recreates the unique
--    index to include service_id, since two different services can legitimately
--    share a (day_of_week, start_time) pair (e.g. lifestyle and bodybuilding
--    both run Sun 9:30).
-- 4. DELETE the orphaned existing rows in availability_templates (no live code
--    reads them — verified via grep across both repos), then re-seed cleanly
--    with proper service_id linkage from the hardcoded SESSIONS schedule.
-- 5. RLS on booking_services via current_client_id() — same pattern as the rest
--    of the schema. Portal endpoints will hit it via supabaseAdmin which bypasses
--    RLS, so policies are defense-in-depth.
--
-- Run in: https://supabase.com/dashboard/project/bnkoqybkmwtrlorhowyv/sql

-- ============================================================
-- 1. Drop unused tables from 0017
-- ============================================================
-- A view `booking_appointments_public` was created out-of-band on the live
-- database (SELECT calendar_id, appointment_start, appointment_end FROM
-- booking_appointments WHERE status <> 'cancelled'). It's not in any repo's
-- migrations and has no live readers since booking_appointments has always
-- been empty. Drop it first so the table drop doesn't error.
DROP VIEW IF EXISTS public.booking_appointments_public;

DROP TABLE IF EXISTS public.booking_appointments;
DROP TABLE IF EXISTS public.booking_availability;
DROP TABLE IF EXISTS public.booking_services;

-- ============================================================
-- 2. Create proper booking_services
-- ============================================================
CREATE TABLE public.booking_services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  key          text NOT NULL,           -- machine key: 'athlete', 'lifestyle', etc.
  name         text NOT NULL,           -- short label: "Athlete Assessment"
  full_name    text NOT NULL,           -- long label: "Free Athlete Performance Assessment"
  btn_text     text,                    -- "CONFIRM SESSION — IT'S FREE"
  max_per_slot integer,                 -- NULL = unlimited capacity
  info_title   text,                    -- "ATHLETE ASSESSMENT SCHEDULE"
  info_note    text,                    -- "Max 10 athletes per session..."
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_services_client_key_uniq UNIQUE (client_id, key)
);

CREATE INDEX booking_services_client_sort_idx
  ON public.booking_services(client_id, sort_order);

DROP TRIGGER IF EXISTS booking_services_touch ON public.booking_services;
CREATE TRIGGER booking_services_touch
  BEFORE UPDATE ON public.booking_services
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- 3. Link availability_templates to booking_services
-- ============================================================
-- The orphaned rows in availability_templates have no service_id and no live
-- reader, so deleting them and re-seeding is the cleanest way to attach each
-- row to the right service.
DELETE FROM public.availability_templates;

ALTER TABLE public.availability_templates
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.booking_services(id) ON DELETE CASCADE;

-- The widget's original unique index was (client_id, day_of_week, start_time)
-- which would prevent two services from sharing the same time slot. Drop and
-- recreate including service_id.
DROP INDEX IF EXISTS public.idx_avail_template_unique;
CREATE UNIQUE INDEX idx_avail_template_unique
  ON public.availability_templates(client_id, service_id, day_of_week, start_time);

CREATE INDEX IF NOT EXISTS availability_templates_service_idx
  ON public.availability_templates(service_id, is_active);

-- ============================================================
-- 4. Seed services + availability for The Flex Facility
-- ============================================================
-- Mirrors the hardcoded SESSIONS object in flex-booking-calendar/index.html
-- (lines 432-519) so Phase 2 can swap the widget over without changing what
-- end users see in the calendar.
DO $$
DECLARE
  v_client_id        uuid;
  v_athlete_id       uuid;
  v_lifestyle_id     uuid;
  v_bodybuilding_id  uuid;
BEGIN
  SELECT id INTO v_client_id FROM public.clients WHERE slug = 'flex-facility';
  IF v_client_id IS NULL THEN
    RAISE NOTICE 'flex-facility client not found, skipping seed';
    RETURN;
  END IF;

  -- Service 1: Athlete Assessment
  INSERT INTO public.booking_services
    (client_id, key, name, full_name, btn_text, max_per_slot, info_title, info_note, sort_order, is_active)
  VALUES
    (v_client_id, 'athlete', 'Athlete Assessment', 'Free Athlete Performance Assessment',
     'CONFIRM SESSION — IT''S FREE', 10,
     'ATHLETE ASSESSMENT SCHEDULE',
     'Max 10 athletes per session. Sessions book fast — grab your spot early.',
     1, true)
  ON CONFLICT (client_id, key) DO UPDATE SET
    name         = EXCLUDED.name,
    full_name    = EXCLUDED.full_name,
    btn_text     = EXCLUDED.btn_text,
    max_per_slot = EXCLUDED.max_per_slot,
    info_title   = EXCLUDED.info_title,
    info_note    = EXCLUDED.info_note,
    sort_order   = EXCLUDED.sort_order,
    is_active    = EXCLUDED.is_active;

  SELECT id INTO v_athlete_id
    FROM public.booking_services
    WHERE client_id = v_client_id AND key = 'athlete';

  -- Service 2: Physique & Lifestyle
  INSERT INTO public.booking_services
    (client_id, key, name, full_name, btn_text, max_per_slot, info_title, info_note, sort_order, is_active)
  VALUES
    (v_client_id, 'lifestyle', 'Physique & Lifestyle', 'Physique & Lifestyle Group Session',
     'CONFIRM GROUP SESSION', NULL,
     'PHYSIQUE & LIFESTYLE SCHEDULE',
     'Group sessions run daily. Last booking accepted 1 hour before closing time.',
     2, true)
  ON CONFLICT (client_id, key) DO UPDATE SET
    name         = EXCLUDED.name,
    full_name    = EXCLUDED.full_name,
    btn_text     = EXCLUDED.btn_text,
    max_per_slot = EXCLUDED.max_per_slot,
    info_title   = EXCLUDED.info_title,
    info_note    = EXCLUDED.info_note,
    sort_order   = EXCLUDED.sort_order,
    is_active    = EXCLUDED.is_active;

  SELECT id INTO v_lifestyle_id
    FROM public.booking_services
    WHERE client_id = v_client_id AND key = 'lifestyle';

  -- Service 3: Bodybuilding
  INSERT INTO public.booking_services
    (client_id, key, name, full_name, btn_text, max_per_slot, info_title, info_note, sort_order, is_active)
  VALUES
    (v_client_id, 'bodybuilding', 'Bodybuilding', 'Bodybuilding Group Session',
     'CONFIRM GROUP SESSION', NULL,
     'BODYBUILDING SCHEDULE',
     'Group sessions run daily. Last booking accepted 1 hour before closing time.',
     3, true)
  ON CONFLICT (client_id, key) DO UPDATE SET
    name         = EXCLUDED.name,
    full_name    = EXCLUDED.full_name,
    btn_text     = EXCLUDED.btn_text,
    max_per_slot = EXCLUDED.max_per_slot,
    info_title   = EXCLUDED.info_title,
    info_note    = EXCLUDED.info_note,
    sort_order   = EXCLUDED.sort_order,
    is_active    = EXCLUDED.is_active;

  SELECT id INTO v_bodybuilding_id
    FROM public.booking_services
    WHERE client_id = v_client_id AND key = 'bodybuilding';

  -- ----- Availability templates per service -----
  -- Athlete: Sun 8:30, Mon 7 PM, Tue 7 PM, Wed 7 PM (1-hour slots)
  INSERT INTO public.availability_templates
    (client_id, service_id, day_of_week, start_time, end_time, slot_duration_minutes, is_active)
  VALUES
    (v_client_id, v_athlete_id, 0, '08:30', '09:30', 60, true),
    (v_client_id, v_athlete_id, 1, '19:00', '20:00', 60, true),
    (v_client_id, v_athlete_id, 2, '19:00', '20:00', 60, true),
    (v_client_id, v_athlete_id, 3, '19:00', '20:00', 60, true)
  ON CONFLICT (client_id, service_id, day_of_week, start_time) DO NOTHING;

  -- Lifestyle: Sun 9:30, Mon 4-6 PM, Tue 7:30-8 AM, Wed 5-6 PM, Thu 7:30-8 AM,
  --            Fri 7:30-9 AM, Sat 7-9 AM
  INSERT INTO public.availability_templates
    (client_id, service_id, day_of_week, start_time, end_time, slot_duration_minutes, is_active)
  VALUES
    (v_client_id, v_lifestyle_id, 0, '09:30', '10:30', 60, true),
    (v_client_id, v_lifestyle_id, 1, '16:00', '17:00', 60, true),
    (v_client_id, v_lifestyle_id, 1, '17:00', '18:00', 60, true),
    (v_client_id, v_lifestyle_id, 1, '18:00', '19:00', 60, true),
    (v_client_id, v_lifestyle_id, 2, '07:30', '08:30', 60, true),
    (v_client_id, v_lifestyle_id, 2, '08:00', '09:00', 60, true),
    (v_client_id, v_lifestyle_id, 3, '17:00', '18:00', 60, true),
    (v_client_id, v_lifestyle_id, 3, '18:00', '19:00', 60, true),
    (v_client_id, v_lifestyle_id, 4, '07:30', '08:30', 60, true),
    (v_client_id, v_lifestyle_id, 4, '08:00', '09:00', 60, true),
    (v_client_id, v_lifestyle_id, 5, '07:30', '08:30', 60, true),
    (v_client_id, v_lifestyle_id, 5, '08:30', '09:30', 60, true),
    (v_client_id, v_lifestyle_id, 5, '09:00', '10:00', 60, true),
    (v_client_id, v_lifestyle_id, 6, '07:00', '08:00', 60, true),
    (v_client_id, v_lifestyle_id, 6, '08:00', '09:00', 60, true),
    (v_client_id, v_lifestyle_id, 6, '09:00', '10:00', 60, true)
  ON CONFLICT (client_id, service_id, day_of_week, start_time) DO NOTHING;

  -- Bodybuilding: same schedule as lifestyle
  INSERT INTO public.availability_templates
    (client_id, service_id, day_of_week, start_time, end_time, slot_duration_minutes, is_active)
  VALUES
    (v_client_id, v_bodybuilding_id, 0, '09:30', '10:30', 60, true),
    (v_client_id, v_bodybuilding_id, 1, '16:00', '17:00', 60, true),
    (v_client_id, v_bodybuilding_id, 1, '17:00', '18:00', 60, true),
    (v_client_id, v_bodybuilding_id, 1, '18:00', '19:00', 60, true),
    (v_client_id, v_bodybuilding_id, 2, '07:30', '08:30', 60, true),
    (v_client_id, v_bodybuilding_id, 2, '08:00', '09:00', 60, true),
    (v_client_id, v_bodybuilding_id, 3, '17:00', '18:00', 60, true),
    (v_client_id, v_bodybuilding_id, 3, '18:00', '19:00', 60, true),
    (v_client_id, v_bodybuilding_id, 4, '07:30', '08:30', 60, true),
    (v_client_id, v_bodybuilding_id, 4, '08:00', '09:00', 60, true),
    (v_client_id, v_bodybuilding_id, 5, '07:30', '08:30', 60, true),
    (v_client_id, v_bodybuilding_id, 5, '08:30', '09:30', 60, true),
    (v_client_id, v_bodybuilding_id, 5, '09:00', '10:00', 60, true),
    (v_client_id, v_bodybuilding_id, 6, '07:00', '08:00', 60, true),
    (v_client_id, v_bodybuilding_id, 6, '08:00', '09:00', 60, true),
    (v_client_id, v_bodybuilding_id, 6, '09:00', '10:00', 60, true)
  ON CONFLICT (client_id, service_id, day_of_week, start_time) DO NOTHING;

END $$;

-- ============================================================
-- 5. RLS on booking_services
-- ============================================================
ALTER TABLE public.booking_services ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_services_tenant_all ON public.booking_services;
CREATE POLICY booking_services_tenant_all ON public.booking_services
  FOR ALL
  USING      (client_id = public.current_client_id())
  WITH CHECK (client_id = public.current_client_id());
