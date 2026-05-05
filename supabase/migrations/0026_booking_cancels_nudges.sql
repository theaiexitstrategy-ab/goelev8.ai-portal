-- © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
-- Auto-cancel pending nudges + tag the lead when a booking is made.
--
-- Catches every path that lands a row in public.bookings:
--   - book.theflexfacility.com widget direct insert
--   - Vapi assistant capturing an appointment (api/events.js)
--   - Portal manual booking via /api/portal/crm?action=bookings
--   - iSlay studio booking via /api/portal/artist
--
-- Without this, a customer who already signed up could keep getting
-- prospect drips for hours. We match the booking back to the lead by
-- direct lead_id first, then by phone, then by email — so even when
-- the widget inserts a booking with no lead_id (because the lead was
-- created on a different funnel page), the matching prospect lead
-- still gets their nudges cancelled.

CREATE OR REPLACE FUNCTION public.cancel_nudges_on_booking()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- 1. Direct lead_id match (most precise)
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE public.nudge_queue
       SET failed_reason = 'booking_made'
     WHERE lead_id = NEW.lead_id
       AND sent_at IS NULL
       AND failed_reason IS NULL;

    -- Tag the originating lead as Booked + Current Client so future
    -- blast filters auto-exclude them too.
    UPDATE public.leads
       SET tags = (
             SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['Booked', 'Current Client']))
           )
     WHERE id = NEW.lead_id;
  END IF;

  -- 2. Phone-based match — catches widget bookings whose lead_id is
  --    null but match an existing prospect by phone in the same tenant.
  IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
    UPDATE public.nudge_queue nq
       SET failed_reason = 'booking_made'
      FROM public.leads l
     WHERE nq.lead_id = l.id
       AND l.client_id = NEW.client_id
       AND l.phone = NEW.phone
       AND nq.sent_at IS NULL
       AND nq.failed_reason IS NULL;

    UPDATE public.leads
       SET tags = (
             SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['Booked', 'Current Client']))
           )
     WHERE client_id = NEW.client_id AND phone = NEW.phone;
  END IF;

  -- 3. Email-based match (last resort if phone is missing).
  IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
    UPDATE public.nudge_queue nq
       SET failed_reason = 'booking_made'
      FROM public.leads l
     WHERE nq.lead_id = l.id
       AND l.client_id = NEW.client_id
       AND lower(l.email) = lower(NEW.email)
       AND nq.sent_at IS NULL
       AND nq.failed_reason IS NULL;

    UPDATE public.leads
       SET tags = (
             SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['Booked', 'Current Client']))
           )
     WHERE client_id = NEW.client_id AND lower(email) = lower(NEW.email);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_cancel_nudges ON public.bookings;
CREATE TRIGGER bookings_cancel_nudges
  AFTER INSERT ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.cancel_nudges_on_booking();
