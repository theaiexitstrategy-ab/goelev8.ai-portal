-- Extend client_portfolio_videos to support Mux Direct Uploads (phone
-- → portal → Mux without the operator ever seeing a Playback ID).
--
-- New lifecycle:
--   uploading   — Mux upload URL issued, waiting for bytes
--   processing  — Mux received the file, is encoding
--   ready       — playback_id populated, safe to render
--   errored     — Mux rejected the upload; error_message set
--
-- Rows in 'uploading' / 'processing' / 'errored' have a NULL
-- mux_playback_id, so the /api/external/portfolio.js filter (drops
-- rows with no playback_id) transparently hides them from public.

-- Make mux_playback_id nullable — was NOT NULL, now can be populated
-- after Mux finishes encoding. Existing rows already have values, so
-- the ALTER is data-safe.
ALTER TABLE public.client_portfolio_videos
  ALTER COLUMN mux_playback_id DROP NOT NULL;

-- Direct-upload bookkeeping. Set at start-upload; asset_id populates
-- once Mux starts processing; playback_id populates once encoding
-- finishes.
ALTER TABLE public.client_portfolio_videos
  ADD COLUMN IF NOT EXISTS mux_asset_id  text,
  ADD COLUMN IF NOT EXISTS mux_upload_id text,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('uploading','processing','ready','errored')),
  ADD COLUMN IF NOT EXISTS error_message   text,
  ADD COLUMN IF NOT EXISTS duration_seconds numeric;

CREATE INDEX IF NOT EXISTS client_portfolio_videos_status_idx
  ON public.client_portfolio_videos(client_id, status);
CREATE INDEX IF NOT EXISTS client_portfolio_videos_upload_id_idx
  ON public.client_portfolio_videos(mux_upload_id)
  WHERE mux_upload_id IS NOT NULL;
