-- Portfolio rows currently render as a Mux "reel". The site's event
-- log page filters by event_type / event_date / venue / city /
-- guest_count — none of which existed on client_portfolio_videos —
-- so filters rendered empty and the site had to merge its seed data
-- over the endpoint response. Add the columns + response shape here
-- so the site becomes fully data-driven.
--
-- Nullable — reels without event context stay useful; the event log
-- page skips rows missing event_date.

ALTER TABLE public.client_portfolio_videos
  ADD COLUMN IF NOT EXISTS event_type text,
  ADD COLUMN IF NOT EXISTS event_date date,
  ADD COLUMN IF NOT EXISTS venue text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS guest_count integer CHECK (guest_count IS NULL OR guest_count >= 0);

CREATE INDEX IF NOT EXISTS client_portfolio_videos_event_date_idx
  ON public.client_portfolio_videos(client_id, event_date DESC)
  WHERE event_date IS NOT NULL;
