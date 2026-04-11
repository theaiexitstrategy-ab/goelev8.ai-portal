// Booking availability — per-service weekly templates (Phase 3 of the
// booking unification).
//
// Reads from / writes to public.availability_templates as linked to
// booking_services in migration 0018. Each row is one bookable slot
// (single hour-long window today, but slot_duration_minutes is stored
// for future use). The widget at book.theflexfacility.com pulls these
// via the flex-booking-calendar /api/services endpoint added in Phase 2.
//
// GET /api/portal/bookings/availability
//   Returns all services for the authed client + their templates,
//   grouped by service for the UI:
//   { services: [{ id, key, name, full_name, max_per_slot,
//                  templates: [{ id, day_of_week, start_time, end_time }, ...] }, ...] }
//
// PUT /api/portal/bookings/availability
//   Body: { service_id, templates: [{ day_of_week, start_time, end_time }, ...] }
//   Replaces all templates for that service. Verifies the service belongs
//   to the authed client first. DELETE-then-INSERT — there's a small race
//   window where the service has zero rows, but this only runs while a
//   portal user is editing and the widget falls back to its hardcoded
//   SESSIONS object on any read failure during that window.

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

// "08:30" or "08:30:00" → "08:30:00" — Postgres time literal format.
function normalizeTime(t) {
  if (typeof t !== 'string') return null;
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return null;
  return t.length === 5 ? t + ':00' : t;
}

// "08:30:00" → 30 (minutes since midnight, used to validate end > start).
function timeToMinutes(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PUT'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;
  if (!clientId) return res.status(403).json({ error: 'no_client_assigned' });

  // Pull the calendar so we can return the timezone alongside the data.
  const { data: calRow } = await supabaseAdmin
    .from('booking_calendars')
    .select('timezone, custom_domain, slug')
    .eq('business_id', clientId)
    .maybeSingle();
  const timezone = calRow?.timezone || null;

  if (req.method === 'GET') {
    // Pull active services in display order, then templates for those
    // services in one round trip and group in JS.
    const { data: services, error: svcErr } = await supabaseAdmin
      .from('booking_services')
      .select('id, key, name, full_name, max_per_slot, sort_order, is_active')
      .eq('client_id', clientId)
      .order('sort_order', { ascending: true });
    if (svcErr) return res.status(500).json({ error: svcErr.message });

    const serviceList = services || [];
    if (!serviceList.length) {
      return res.status(200).json({ services: [], timezone });
    }

    const serviceIds = serviceList.map(s => s.id);
    const { data: templates, error: tplErr } = await supabaseAdmin
      .from('availability_templates')
      .select('id, service_id, day_of_week, start_time, end_time, slot_duration_minutes, is_active')
      .in('service_id', serviceIds)
      .order('day_of_week', { ascending: true })
      .order('start_time', { ascending: true });
    if (tplErr) return res.status(500).json({ error: tplErr.message });

    const tplByService = {};
    for (const t of (templates || [])) {
      if (!tplByService[t.service_id]) tplByService[t.service_id] = [];
      tplByService[t.service_id].push({
        id:          t.id,
        day_of_week: t.day_of_week,
        start_time:  t.start_time,
        end_time:    t.end_time,
        is_active:   t.is_active
      });
    }

    return res.status(200).json({
      services: serviceList.map(s => ({
        id:           s.id,
        key:          s.key,
        name:         s.name,
        full_name:    s.full_name,
        max_per_slot: s.max_per_slot,
        sort_order:   s.sort_order,
        is_active:    s.is_active,
        templates:    tplByService[s.id] || []
      })),
      timezone
    });
  }

  if (req.method === 'PUT') {
    const body = await readJson(req);
    const { service_id } = body;
    if (!service_id)              return res.status(400).json({ error: 'service_id_required' });
    if (!Array.isArray(body.templates)) return res.status(400).json({ error: 'templates_array_required' });

    // Verify the service belongs to the authed client before touching
    // anything. The widget endpoint accepts any service_id with no auth
    // (it's read-only public), so we have to be strict here.
    const { data: svc, error: svcErr } = await supabaseAdmin
      .from('booking_services')
      .select('id, client_id')
      .eq('id', service_id)
      .eq('client_id', clientId)
      .maybeSingle();
    if (svcErr) return res.status(500).json({ error: svcErr.message });
    if (!svc)   return res.status(404).json({ error: 'service_not_found' });

    // Validate + normalize each incoming row.
    const rows = [];
    for (const t of body.templates) {
      const dow = +t.day_of_week;
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
        return res.status(400).json({ error: 'invalid_day_of_week' });
      }
      const start = normalizeTime(t.start_time);
      const end   = normalizeTime(t.end_time);
      if (!start || !end) return res.status(400).json({ error: 'invalid_time_format' });
      if (timeToMinutes(end) <= timeToMinutes(start)) {
        return res.status(400).json({ error: 'end_time_must_be_after_start_time' });
      }
      const duration = timeToMinutes(end) - timeToMinutes(start);
      rows.push({
        client_id:             clientId,
        service_id,
        day_of_week:           dow,
        start_time:            start,
        end_time:              end,
        slot_duration_minutes: duration,
        is_active:             true
      });
    }

    // Replace all templates for this service: DELETE existing, INSERT new.
    // Atomic-enough for the portal use case — only one operator edits at
    // a time, and the widget read path falls back to hardcoded SESSIONS
    // on any read failure.
    const { error: delErr } = await supabaseAdmin
      .from('availability_templates')
      .delete()
      .eq('service_id', service_id)
      .eq('client_id', clientId);
    if (delErr) return res.status(500).json({ error: 'delete_failed: ' + delErr.message });

    if (rows.length) {
      const { error: insErr } = await supabaseAdmin
        .from('availability_templates')
        .insert(rows);
      if (insErr) return res.status(500).json({ error: 'insert_failed: ' + insErr.message });
    }

    // Return the new full set so the UI can refresh in place.
    const { data: fresh, error: freshErr } = await supabaseAdmin
      .from('availability_templates')
      .select('id, service_id, day_of_week, start_time, end_time')
      .eq('service_id', service_id)
      .eq('client_id', clientId)
      .order('day_of_week', { ascending: true })
      .order('start_time', { ascending: true });
    if (freshErr) return res.status(500).json({ error: freshErr.message });

    return res.status(200).json({ templates: fresh || [] });
  }
}
