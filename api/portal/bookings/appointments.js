// Booking appointments — tenant-scoped read + status update.
//
// Reads from / writes to the legacy public.bookings table, which the public
// booking widget at book.theflexfacility.com (repo: flex-booking-calendar)
// already extends with lead_name/phone/email/source columns. The portal
// Bookings tab and the live widget therefore share one table — no sync, no
// double-write. The newer booking_appointments table from migration 0017
// is currently unused; this endpoint deliberately ignores it.
//
// GET   ?filter=all|upcoming|past|cancelled  (default: upcoming)
// PATCH body: { id, status }  where status ∈ {confirmed, cancelled, no_show}
//
// No DELETE: status transitions only.

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

// Status values stored in DB by the live widget are Title-cased: 'Confirmed',
// 'Cancelled', etc. (see api/cancel.js in flex-booking-calendar). We accept
// the portal's lowercase shape on the wire and translate at the boundary so
// the DB stays consistent with whatever the widget writes.
const PORTAL_TO_DB_STATUS = {
  pending:   'Pending',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  no_show:   'No Show'
};
const ALLOWED_PORTAL_STATUSES = new Set(Object.keys(PORTAL_TO_DB_STATUS));

// Normalize whatever case/spacing the DB has into the portal's lowercase
// canonical form, so the frontend's badge map and action gating work
// regardless of how a row was originally written.
function dbStatusToPortal(s) {
  if (!s) return 'pending';
  const norm = String(s).toLowerCase().replace(/[\s-]+/g, '_');
  if (norm === 'scheduled') return 'pending';   // 0001_init.sql default
  if (norm === 'completed') return 'confirmed'; // legacy CRM 'completed' → done
  return norm;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;
  if (!clientId) return res.status(403).json({ error: 'no_client_assigned' });

  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const filter = url.searchParams.get('filter') || 'upcoming';
    const nowIso = new Date().toISOString();

    let q = supabaseAdmin
      .from('bookings')
      .select('id, client_id, lead_id, lead_name, phone, email, service, service_type, starts_at, status, notes, source, created_at')
      .eq('client_id', clientId);

    // Status filtering is case-insensitive against the canonical Title-cased
    // values the widget writes. We do post-fetch filtering for cancelled
    // because the legacy column is freeform text and might contain variants.
    if (filter === 'upcoming') {
      q = q.gte('starts_at', nowIso).order('starts_at', { ascending: true });
    } else if (filter === 'past') {
      q = q.lt('starts_at', nowIso).order('starts_at', { ascending: false });
    } else if (filter === 'cancelled') {
      q = q.order('starts_at', { ascending: false });
    } else {
      q = q.order('starts_at', { ascending: false });
    }

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Map legacy columns to the shape the portal UI expects, then apply
    // status-side filtering for upcoming/cancelled.
    let rows = (data || []).map(b => ({
      id:                b.id,
      lead_name:         b.lead_name || null,
      lead_phone:        b.phone || null,
      lead_email:        b.email || null,
      service_name:      b.service || b.service_type || null,
      appointment_start: b.starts_at,
      status:            dbStatusToPortal(b.status),
      notes:             b.notes || null,
      source:            b.source || null,
      created_at:        b.created_at
    }));

    if (filter === 'upcoming')  rows = rows.filter(r => r.status !== 'cancelled');
    if (filter === 'cancelled') rows = rows.filter(r => r.status === 'cancelled');

    return res.status(200).json({ appointments: rows });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, status } = body;
    if (!id)     return res.status(400).json({ error: 'id_required' });
    if (!status) return res.status(400).json({ error: 'status_required' });
    if (!ALLOWED_PORTAL_STATUSES.has(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }

    // Translate to the Title-cased form the live widget uses, then update
    // scoped by both id AND client_id so a crafted id from another tenant
    // can't update a row.
    const dbStatus = PORTAL_TO_DB_STATUS[status];
    const { data, error } = await supabaseAdmin
      .from('bookings')
      .update({ status: dbStatus })
      .eq('id', id)
      .eq('client_id', clientId)
      .select('id, status')
      .single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({
      appointment: { id: data.id, status: dbStatusToPortal(data.status) }
    });
  }
}
