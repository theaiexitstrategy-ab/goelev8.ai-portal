// Booking appointments — tenant-scoped read + status update.
// GET  — list appointments for this client's calendar, joined with service name.
//        Query: ?filter=all|upcoming|past|cancelled  (default: upcoming)
// PATCH — body: { id, status }  where status ∈ {confirmed, cancelled, no_show}
//
// No DELETE: the spec forbids it — status transitions only.

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

const ALLOWED_STATUSES = new Set(['pending', 'confirmed', 'cancelled', 'no_show']);

async function resolveCalendarId(res, clientId) {
  const { data, error } = await supabaseAdmin
    .from('booking_calendars')
    .select('id')
    .eq('business_id', clientId)
    .maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return null; }
  if (!data) { res.status(404).json({ error: 'no_calendar_for_client' }); return null; }
  return data.id;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  const calendarId = await resolveCalendarId(res, clientId);
  if (!calendarId) return;

  if (req.method === 'GET') {
    // Codebase parses its own URL rather than relying on req.query (some
    // Vercel runtimes don't populate it in ESM handlers).
    const url = new URL(req.url, `http://${req.headers.host}`);
    const filter = url.searchParams.get('filter') || 'upcoming';
    const nowIso = new Date().toISOString();

    let q = supabaseAdmin
      .from('booking_appointments')
      .select('id, calendar_id, service_id, lead_name, lead_phone, lead_email, appointment_start, appointment_end, status, notes, created_at, booking_services(name, duration_minutes, price_cents)')
      .eq('calendar_id', calendarId);

    if (filter === 'upcoming') {
      q = q.gte('appointment_start', nowIso).neq('status', 'cancelled').order('appointment_start', { ascending: true });
    } else if (filter === 'past') {
      q = q.lt('appointment_start', nowIso).order('appointment_start', { ascending: false });
    } else if (filter === 'cancelled') {
      q = q.eq('status', 'cancelled').order('appointment_start', { ascending: false });
    } else {
      // 'all'
      q = q.order('appointment_start', { ascending: true });
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Flatten the embedded service so the client doesn't need to walk it.
    const appointments = (data || []).map(row => ({
      ...row,
      service_name: row.booking_services?.name || null,
      booking_services: undefined
    }));
    return res.status(200).json({ appointments });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, status } = body;
    if (!id)     return res.status(400).json({ error: 'id_required' });
    if (!status) return res.status(400).json({ error: 'status_required' });
    if (!ALLOWED_STATUSES.has(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }

    // Scope by both id and calendar_id to prevent cross-tenant updates.
    const { data, error } = await supabaseAdmin
      .from('booking_appointments')
      .update({ status })
      .eq('id', id)
      .eq('calendar_id', calendarId)
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ appointment: data });
  }
}
