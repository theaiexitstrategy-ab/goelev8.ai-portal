// GET /api/portal/bookings/calendar
// Returns the booking_calendars row for the authed client, or null if none.
// Used by the Bookings tab to (a) gate visibility and (b) render the
// booking link widget (custom_domain || slug fallback).

import { requireUser, methodGuard } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  const { data, error } = await supabaseAdmin
    .from('booking_calendars')
    .select('id, business_id, slug, custom_domain, title, timezone, booking_window_days, min_notice_hours, is_active')
    .eq('business_id', clientId)
    .maybeSingle();

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ calendar: data || null });
}
