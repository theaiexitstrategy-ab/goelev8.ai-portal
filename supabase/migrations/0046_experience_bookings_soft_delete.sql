-- Soft-delete for experience_bookings.
--
-- The KB Bookings tab was read-only: /api/portal/experience-bookings
-- served GET + PATCH and 405'd everything else, and the table had no
-- actions column at all. An operator with a test row, a duplicate, or a
-- guest who submitted three times had no way to clear it — the only
-- "removal" available was PATCH status='cancelled', which is a different
-- statement (it tells the guest's story, it doesn't tidy the ledger) and
-- leaves the row in every count.
--
-- Same mechanism migration 0024 gave leads / contacts / bookings:
-- deleted_at timestamptz, filtered out of reads, recoverable by clearing
-- the column. Hard DELETE is deliberately not offered — these rows carry
-- stripe_session_id / stripe_payment_intent / application_fee_cents, so a
-- destroyed row is a destroyed audit trail for money that actually moved.
--
-- Counts move with the filter on purpose. A deleted confirmed booking
-- leaves counts.deposits_cents and counts.fees_cents, so deleting is a
-- reporting decision, not just a cosmetic one; the portal confirms that
-- explicitly before sending the request when a deposit was collected.

ALTER TABLE public.experience_bookings
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Partial index: every read filters `deleted_at is null`, and deleted
-- rows are rare, so indexing only the live ones keeps it small.
CREATE INDEX IF NOT EXISTS experience_bookings_client_live_idx
  ON public.experience_bookings (client_id, created_at DESC)
  WHERE deleted_at IS NULL;
