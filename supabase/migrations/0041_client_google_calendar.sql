-- Per-tenant Google Calendar link + sync state. Any tenant with the
-- 'connect' or 'settings' UI can OAuth their Google Calendar; the
-- portal then two-way syncs:
--   Google → portal  (busy blocks suppress bookable slots)
--   portal → Google  (confirmed deposit_bookings write back as events)
--
-- One row per tenant. Access token is short-lived (~1h); refresh
-- token lives forever until the user revokes it in their Google
-- account. Tokens are RLS-locked to admin + tenant read; only
-- supabaseAdmin can write, so tenant users can never leak them via a
-- rogue browser query.

CREATE TABLE IF NOT EXISTS public.client_google_calendar (
  client_id            uuid PRIMARY KEY REFERENCES public.clients(id) ON DELETE CASCADE,

  -- Which Google account is connected. Cached from userinfo at
  -- OAuth callback time so the Settings UI can show "Connected as
  -- stephen@konqueredbalance.com" without a live Google round-trip.
  google_email         text,
  google_account_id    text,

  -- Which of the account's calendars we sync with. Typically
  -- 'primary' but could be a shared calendar the operator picked.
  calendar_id          text NOT NULL DEFAULT 'primary',
  calendar_summary     text,

  -- OAuth tokens. Access token rotates; refresh token is issued
  -- once by Google (requires access_type=offline + prompt=consent
  -- on the auth URL) and is used to mint new access tokens.
  access_token         text,
  refresh_token        text,
  token_expires_at     timestamptz,
  scopes               text[] NOT NULL DEFAULT '{}',

  -- Google Calendar push notification channel. Google returns
  -- channel_id + resource_id; we send them back on Stop and match
  -- them on incoming X-Goog-Channel-Id headers. Channels expire
  -- after ~7 days; cron renews before expiration.
  channel_id           text,
  channel_resource_id  text,
  channel_expiration   timestamptz,

  -- Incremental sync bookmark. Passed as syncToken to
  -- events.list() so we only fetch what changed since the last
  -- successful pass.
  sync_token           text,
  last_synced_at       timestamptz,
  last_sync_error      text,

  connected_at         timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS client_google_calendar_channel_idx
  ON public.client_google_calendar(channel_id) WHERE channel_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS client_google_calendar_expiring_idx
  ON public.client_google_calendar(channel_expiration) WHERE channel_expiration IS NOT NULL;

-- Busy-blocks cache. Whenever we sync, we materialize the tenant's
-- non-transparent Google events for the near future as busy ranges.
-- The availability endpoint reads this table instead of hitting
-- Google on every request (huge quota + latency savings).
CREATE TABLE IF NOT EXISTS public.google_calendar_busy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  event_id       text NOT NULL,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  summary        text,
  cached_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_calendar_busy_uniq UNIQUE (client_id, event_id)
);
CREATE INDEX IF NOT EXISTS google_calendar_busy_range_idx
  ON public.google_calendar_busy(client_id, starts_at, ends_at);

-- experience_bookings gets a Google event id so we can update /
-- delete the mirrored event on later status changes.
ALTER TABLE public.experience_bookings
  ADD COLUMN IF NOT EXISTS google_event_id text,
  ADD COLUMN IF NOT EXISTS google_calendar_id text;
CREATE INDEX IF NOT EXISTS experience_bookings_gcal_idx
  ON public.experience_bookings(google_event_id) WHERE google_event_id IS NOT NULL;

-- RLS. Tokens are never anon-readable. Admin + tenant get read (so
-- the SPA Settings panel can show connected status), but writes go
-- through supabaseAdmin only.
ALTER TABLE public.client_google_calendar ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cgc_admin_all ON public.client_google_calendar;
CREATE POLICY cgc_admin_all ON public.client_google_calendar
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()))
  WITH CHECK ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));
DROP POLICY IF EXISTS cgc_tenant_read ON public.client_google_calendar;
CREATE POLICY cgc_tenant_read ON public.client_google_calendar
  FOR SELECT TO authenticated
  USING (client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid()));

ALTER TABLE public.google_calendar_busy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS gcb_admin_all ON public.google_calendar_busy;
CREATE POLICY gcb_admin_all ON public.google_calendar_busy
  FOR ALL TO authenticated
  USING      ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()))
  WITH CHECK ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));
DROP POLICY IF EXISTS gcb_tenant_read ON public.google_calendar_busy;
CREATE POLICY gcb_tenant_read ON public.google_calendar_busy
  FOR SELECT TO authenticated
  USING (client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid()));
