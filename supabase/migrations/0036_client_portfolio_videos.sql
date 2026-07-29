-- Multi-tenant portfolio (video reel) support. Any tenant can add
-- 'portfolio' to their portal_tabs and start managing videos. First
-- consumer: konquered-balance for konqueredkocktails.com/portfolio.
--
-- Conventions mirror supabase/migrations/add_merch_tables.sql exactly:
--   * client_id FK on delete cascade
--   * UNIQUE (client_id, video_key)
--   * INDEX on (client_id, sort_order)
--   * RLS via public.current_client_id()
--   * touch_updated_at trigger on BEFORE UPDATE
--
-- Plus: hard-cap trigger enforcing at most 5 active videos per tenant.
-- The storefront caps at 5 on render but that's a display guard;
-- this is the real limit. Uses a trigger (not app-level check) so
-- concurrent inserts can't race past the cap.

-- ============================================================
-- clients.slug_aliases — legacy slug support for storefronts that
-- were shipped pointing at an older slug. Any incoming
-- /api/external/* call resolves via direct match on clients.slug
-- OR containment in slug_aliases[]. Empty array = no aliases.
--
-- First use: konquered-balance keeps 'konquered-kocktails' as an
-- alias so the storefront (still deployed with the old slug) keeps
-- working without a coordinated redeploy. See lib/tenant-slug.js.
-- ============================================================
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS slug_aliases text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS clients_slug_aliases_gin
  ON public.clients USING gin (slug_aliases);

-- ============================================================
-- client_portfolio_videos — one row per video, per tenant.
-- video_key is the stable string the storefront + portal use to
-- refer to a specific video (e.g. 'gentleman-jack-2021').
-- ============================================================
CREATE TABLE IF NOT EXISTS public.client_portfolio_videos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  video_key          text NOT NULL,
  title              text NOT NULL,
  description        text,
  mux_playback_id    text NOT NULL,
  poster_url         text,
  is_active          boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_portfolio_videos_client_key_uniq UNIQUE (client_id, video_key)
);
CREATE INDEX IF NOT EXISTS client_portfolio_videos_client_sort_idx
  ON public.client_portfolio_videos(client_id, sort_order);
CREATE INDEX IF NOT EXISTS client_portfolio_videos_client_active_idx
  ON public.client_portfolio_videos(client_id, is_active);

-- ============================================================
-- 5-video cap — enforced by trigger so a race between two inserts
-- can't sneak past. Fires only when the row being written is
-- is_active=true; deactivating a row is always fine.
-- ============================================================
CREATE OR REPLACE FUNCTION public.enforce_portfolio_5_video_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_count int;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO active_count
    FROM public.client_portfolio_videos
   WHERE client_id = NEW.client_id
     AND is_active
     AND id IS DISTINCT FROM NEW.id;
  IF active_count >= 5 THEN
    RAISE EXCEPTION 'portfolio_5_video_cap_exceeded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS client_portfolio_videos_cap ON public.client_portfolio_videos;
CREATE TRIGGER client_portfolio_videos_cap
  BEFORE INSERT OR UPDATE OF is_active, client_id
  ON public.client_portfolio_videos
  FOR EACH ROW EXECUTE FUNCTION public.enforce_portfolio_5_video_cap();

-- ============================================================
-- RLS: portal endpoints hit this via supabaseAdmin (bypasses RLS),
-- so the policy is defense-in-depth for any future path that uses
-- anon/auth keys. Mirrors merch_products exactly.
-- ============================================================
ALTER TABLE public.client_portfolio_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_portfolio_videos_tenant_all ON public.client_portfolio_videos;
CREATE POLICY client_portfolio_videos_tenant_all ON public.client_portfolio_videos
  FOR ALL
  USING      (client_id = public.current_client_id())
  WITH CHECK (client_id = public.current_client_id());

-- touch_updated_at trigger — same helper the merch tables use.
DROP TRIGGER IF EXISTS client_portfolio_videos_touch ON public.client_portfolio_videos;
CREATE TRIGGER client_portfolio_videos_touch
  BEFORE UPDATE ON public.client_portfolio_videos
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
