-- Two related additions for the experience tenants (Konquered Balance
-- first). Both exist to make a finished event findable later instead of
-- something that scrolls off the bottom of a list.
--
-- 1. experience_bookings.archived_at
--
-- The Bookings tab had exactly one axis: status. That conflates three
-- unrelated questions — did they pay (deposit_pending/confirmed), did it
-- fall through (cancelled/refunded), and is it still something I need to
-- look at. A finished, fully-paid event from three months ago is
-- 'confirmed' forever and sits at the top of the list next to next
-- week's. Archiving answers the third question on its own axis.
--
-- Deliberately NOT deleted_at (0046): a deleted row is one that should
-- never have been in the ledger and leaves every count; an archived row
-- happened, earned money, and stays in every total. Only the default row
-- listing hides it. Keeping the money in the totals is the whole reason
-- these are two columns and not one enum.
--
-- 2. client_portfolio_videos.booking_id
--
-- Migration 0040 added event_type / event_date / venue / city /
-- guest_count so konqueredkocktails.com/events could be data-driven, and
-- api/external/portfolio.js serves them — but nothing ever wrote them
-- (the portal editor has no fields for them), so all five are NULL on
-- every row and that page has nothing to filter. The booking already
-- knows the date, the guest count and which experience it was, so
-- linking a video to its booking fills those in from the row that is
-- already the source of truth instead of asking an operator to retype
-- facts the system has.
--
-- ON DELETE SET NULL, not CASCADE: soft-deleting or hard-deleting a
-- booking must never take the published video off the public site with
-- it. The video keeps the event metadata that was copied onto it; it
-- just stops pointing at a row that is gone.

ALTER TABLE public.experience_bookings
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Partial: the default listing filters `archived_at is null` alongside
-- `deleted_at is null`, and archived rows are the minority.
CREATE INDEX IF NOT EXISTS experience_bookings_client_open_idx
  ON public.experience_bookings (client_id, created_at DESC)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

ALTER TABLE public.client_portfolio_videos
  ADD COLUMN IF NOT EXISTS booking_id uuid
    REFERENCES public.experience_bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS client_portfolio_videos_booking_idx
  ON public.client_portfolio_videos (booking_id)
  WHERE booking_id IS NOT NULL;
