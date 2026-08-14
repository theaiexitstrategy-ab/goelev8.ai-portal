-- Pin the ROQ N FLEX Bootcamp to a 10% platform fee, and correct the one
-- reservation already recorded under the wrong rate.
--
-- WHAT WENT WRONG
-- ---------------
-- clients.platform_fee_pct is 7.00 for flex-facility — their MERCH rate.
-- 0042 seeded the bootcamp with platform_fee_pct NULL, which means
-- "inherit", so the event resolved to 7% instead of the 10% the bootcamp
-- was specified at. The first real seat was recorded with a $0.70
-- platform fee while Stripe had actually taken $1.61.
--
-- This is exactly what the per-event override column exists for: one
-- tenant can sell merch at one rate and event seats at another. Leaving
-- it NULL made the event silently inherit the wrong one.
--
-- It matters well beyond reporting. At cutover, api/external/
-- event-reservations.js sets application_fee_amount from this same
-- resolution chain — so a 7% event would quietly pay the tenant $9.30 and
-- GoElev8 $0.70 per seat instead of the specified $9.00 / $1.00. The
-- customer total is unaffected either way ($10.61; the gross-up is
-- computed on list price, not on the fee), which is precisely what would
-- have made this hard to notice.
update public.tenant_events
set platform_fee_pct = 10, updated_at = now()
where event_key = 'roq-n-flex-bootcamp'
  and platform_fee_pct is distinct from 10;

-- Correct the already-mirrored seat to the fees Stripe actually applied.
-- Source of truth is the charge, not our config:
--   charge                 $10.61
--   application_fee_amount  $1.61  → GoElev8
--   Stripe processing       $0.61  (2.9% + 30c on 1061, paid by the
--                                   platform on a destination charge)
--   platform net            $1.00
--   tenant net              $9.00
-- Scoped to the rows that carry the wrong computed values so re-running
-- can't disturb correctly-recorded ones.
update public.event_reservations
set platform_fee_cents    = 100,
    stripe_fee_cents      = 61,
    application_fee_cents = 161,
    updated_at            = now()
where source = 'flex_marketing_site'
  and amount_total_cents = 1061
  and application_fee_cents is distinct from 161;
