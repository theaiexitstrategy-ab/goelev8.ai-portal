-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
-- 30-day soft-delete recovery for leads, contacts, bookings.
--
-- Replaces the existing hard-delete behavior with a deleted_at timestamp
-- so an operator can recover a record from a "Trash" view within 30 days
-- of removal. Records older than 30 days are hidden from the UI but stay
-- in the table until a future purge job (or manual cleanup) removes them.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS leads_deleted_at_idx
  ON public.leads(client_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_deleted_at_idx
  ON public.contacts(client_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_deleted_at_idx
  ON public.bookings(client_id, deleted_at) WHERE deleted_at IS NOT NULL;
