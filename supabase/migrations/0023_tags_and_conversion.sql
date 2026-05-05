-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
-- Cross-tenant tagging + free→paid conversion tracking.
--
-- - Adds tags[] to bookings (leads.tags + contacts.tags already existed
--   from earlier migrations).
-- - Adds paid_at timestamptz to bookings AND leads so the "Mark as Paid"
--   button has a stable, queryable conversion timestamp regardless of
--   whether the original booking was free or paid.
-- - Sets up GIN indexes on every tags column for fast tag-based blast
--   filtering (tags && '{Current Client,VIP}').

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS tags    text[]        NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

CREATE INDEX IF NOT EXISTS bookings_tags_gin   ON public.bookings   USING gin(tags);
CREATE INDEX IF NOT EXISTS contacts_tags_gin   ON public.contacts   USING gin(tags);
CREATE INDEX IF NOT EXISTS leads_tags_gin_idx  ON public.leads      USING gin(tags);

CREATE INDEX IF NOT EXISTS bookings_paid_at_idx ON public.bookings(client_id, paid_at) WHERE paid_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leads_paid_at_idx    ON public.leads(client_id, paid_at)    WHERE paid_at IS NOT NULL;
