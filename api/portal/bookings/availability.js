// Booking availability — weekly recurring windows (one row per day_of_week).
// GET — returns rows for this client's calendar, ordered Mon..Sun.
// PUT — body: { days: [{ day_of_week, start_time, end_time, is_active }, ...] }
//        Upserts each provided day by (calendar_id, day_of_week).

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

async function resolveCalendar(res, clientId) {
  const { data, error } = await supabaseAdmin
    .from('booking_calendars')
    .select('id, timezone')
    .eq('business_id', clientId)
    .maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return null; }
  if (!data) { res.status(404).json({ error: 'no_calendar_for_client' }); return null; }
  return data;
}

// Accept either "HH:MM" or "HH:MM:SS" from the client; Postgres time column
// normalizes storage. Reject anything that doesn't look like a time literal.
function normalizeTime(t) {
  if (typeof t !== 'string') return null;
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return null;
  return t.length === 5 ? t + ':00' : t;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PUT'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  const cal = await resolveCalendar(res, clientId);
  if (!cal) return;

  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('booking_availability')
      .select('*')
      .eq('calendar_id', cal.id)
      .order('day_of_week', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ availability: data || [], timezone: cal.timezone });
  }

  if (req.method === 'PUT') {
    const body = await readJson(req);
    const days = Array.isArray(body.days) ? body.days : null;
    if (!days) return res.status(400).json({ error: 'days_array_required' });

    const rows = [];
    for (const d of days) {
      const dow = +d.day_of_week;
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
        return res.status(400).json({ error: 'invalid_day_of_week' });
      }
      const start = normalizeTime(d.start_time);
      const end   = normalizeTime(d.end_time);
      if (!start || !end) return res.status(400).json({ error: 'invalid_time_format' });
      if (end <= start)   return res.status(400).json({ error: 'end_time_must_be_after_start_time' });
      rows.push({
        calendar_id: cal.id,
        day_of_week: dow,
        start_time:  start,
        end_time:    end,
        is_active:   d.is_active !== false
      });
    }

    // Upsert by (calendar_id, day_of_week) — keyed on the unique index the
    // migration creates. This lets the UI send the whole week in one call.
    const { data, error } = await supabaseAdmin
      .from('booking_availability')
      .upsert(rows, { onConflict: 'calendar_id,day_of_week' })
      .select();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ availability: data || [] });
  }
}
