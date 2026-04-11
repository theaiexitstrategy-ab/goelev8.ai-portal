// Booking services CRUD — scoped to the authed client's calendar.
// GET    — list services for this client's calendar
// POST   — create service
// PATCH  — update service (inline edit, or toggle is_active for soft-delete)
//
// No hard DELETE: the spec requires soft delete via is_active: false, which
// happens through PATCH.

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

// Look up the authed client's calendar and return its id, or send a 404 and
// return null. Every request must resolve a calendar before touching services.
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
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  const calendarId = await resolveCalendarId(res, clientId);
  if (!calendarId) return;

  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('booking_services')
      .select('*')
      .eq('calendar_id', calendarId)
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ services: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const name = (body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const duration_minutes = Number.isFinite(+body.duration_minutes) ? +body.duration_minutes : 30;
    const price_cents      = Number.isFinite(+body.price_cents)      ? +body.price_cents      : 0;
    const description      = typeof body.description === 'string' ? body.description.trim() || null : null;

    const { data, error } = await supabaseAdmin
      .from('booking_services')
      .insert({
        calendar_id: calendarId,
        name,
        description,
        duration_minutes,
        price_cents,
        is_active: true
      })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ service: data });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });

    // Whitelist writable fields to prevent tenant tampering (calendar_id, etc).
    const patch = {};
    if (typeof body.name === 'string')             patch.name = body.name.trim();
    if (typeof body.description === 'string')      patch.description = body.description.trim() || null;
    if (Number.isFinite(+body.duration_minutes))   patch.duration_minutes = +body.duration_minutes;
    if (Number.isFinite(+body.price_cents))        patch.price_cents = +body.price_cents;
    if (typeof body.is_active === 'boolean')       patch.is_active = body.is_active;
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    // Double-scope: match both id AND calendar_id so a crafted id from
    // another tenant can't update a row.
    const { data, error } = await supabaseAdmin
      .from('booking_services')
      .update(patch)
      .eq('id', id)
      .eq('calendar_id', calendarId)
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ service: data });
  }
}
