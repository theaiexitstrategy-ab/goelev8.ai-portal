-- Idempotency marker for the reviews notification cron. When a review
-- is inserted (anon path from the storefront capture page), this
-- column is NULL. The cron endpoint /api/cron/reviews-notify picks
-- up rows where tenant_alert_sent_at IS NULL, notifies the tenant
-- owner, then stamps the column so the row is never re-notified.

ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS tenant_alert_sent_at timestamptz;
CREATE INDEX IF NOT EXISTS reviews_pending_alert_idx
  ON public.reviews(client_id, created_at)
  WHERE tenant_alert_sent_at IS NULL;
