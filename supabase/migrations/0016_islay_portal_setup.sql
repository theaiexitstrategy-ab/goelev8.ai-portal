-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
-- Migration 0016: iSlay portal setup
--
-- Adds:
--   • portal_tabs jsonb column to clients (per-client nav customization)
--   • funnel_views table (page view tracking for conversion metrics)
--   • Updates iSlay Studios client with logo, brand color, and tab config

-- ============================================================
-- 1. Add portal_tabs column to clients
-- ============================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS portal_tabs jsonb;

-- ============================================================
-- 2. Update iSlay Studios client record
-- ============================================================
UPDATE public.clients SET
  logo_url    = '/images/islay-logo.png',
  brand_color = '#C9A84C',
  portal_tabs = '["leads","messages","blasts","nudges","settings"]'::jsonb
WHERE slug = 'islay-studios';

-- ============================================================
-- 3. Funnel view tracking table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.funnel_views (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  slug       text        NOT NULL,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  referrer   text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS funnel_views_client_idx
  ON public.funnel_views(client_id);
CREATE INDEX IF NOT EXISTS funnel_views_time_idx
  ON public.funnel_views(viewed_at);
CREATE INDEX IF NOT EXISTS funnel_views_slug_idx
  ON public.funnel_views(slug);

ALTER TABLE public.funnel_views ENABLE ROW LEVEL SECURITY;

-- Service role has full access; client users can read their own views
CREATE POLICY funnel_views_select ON public.funnel_views
  FOR SELECT USING (
    client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid())
  );

-- Insert is open (tracking pixel fires from public pages without auth)
CREATE POLICY funnel_views_insert ON public.funnel_views
  FOR INSERT WITH CHECK (true);

GRANT ALL ON public.funnel_views TO service_role;

-- ============================================================
-- 4. Nudge log table (tracks which nudge messages were sent to leads)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.nudge_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid        NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  lead_id         uuid        NOT NULL,
  message_number  smallint    NOT NULL,
  status          text        NOT NULL DEFAULT 'pending',
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS nudge_log_lead_idx
  ON public.nudge_log(lead_id, message_number);
CREATE INDEX IF NOT EXISTS nudge_log_client_idx
  ON public.nudge_log(client_id);

ALTER TABLE public.nudge_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY nudge_log_tenant ON public.nudge_log
  FOR ALL USING (
    client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid())
  );

GRANT ALL ON public.nudge_log TO service_role;
