-- Collapse Overview + Leads into a single sidebar entry for The Flex
-- Facility, making room for the Events tab added in 0042 without the
-- sidebar growing.
--
-- The two pages aren't removed — app.js routes flex-facility's 'overview'
-- tab to viewDashboardHub(), which renders them as sub-tabs behind one
-- entry. Same trade Konquered Balance made when its sidebar hit 11 (see
-- commit 79d6720); this is that pattern applied to a second tenant, now
-- against the generic viewOverview / viewLeads rather than KB's own.
--
-- Flex goes from 9 top-level tabs to 8:
--   overview / leads / trainer_applications / merch / messaging /
--   bookings / analytics / settings / events        (9)
-- to:
--   overview (= Overview + Leads) / trainer_applications / merch /
--   messaging / bookings / analytics / settings / events   (8)
--
-- Deep links to ?tab=leads still resolve — the router keeps its standalone
-- 'leads' case, this only changes what the sidebar offers.
--
-- Idempotent: the `?` guard makes a re-run a no-op. The jsonb `-` operator
-- removes every matching string element from the array.
update public.clients
set portal_tabs = portal_tabs - 'leads'
where slug = 'flex-facility'
  and portal_tabs is not null
  and portal_tabs ? 'leads';
