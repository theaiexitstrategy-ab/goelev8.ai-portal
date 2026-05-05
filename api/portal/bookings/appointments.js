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

    // Try the query with the new tags + paid_at columns first; fall back
    // to the legacy column set if migration 0023 hasn't been applied yet.
    // Without this, the entire Bookings page errors out for any portal
    // whose Supabase project hasn't had the migration run.
    const fullCols  = 'id, client_id, lead_id, lead_name, phone, email, service, service_type, starts_at, status, notes, source, created_at, tags, paid_at';
    const legacyCols = 'id, client_id, lead_id, lead_name, phone, email, service, service_type, starts_at, status, notes, source, created_at';
    let q = supabaseAdmin
      .from('bookings')
      .select(fullCols)
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

    let { data, error } = await q;
    // If migration 0023 hasn't been applied yet the new columns don't
    // exist — retry with the legacy SELECT so the page still loads.
    if (error && /column .*\b(tags|paid_at)\b.* does not exist/i.test(error.message)) {
      let q2 = supabaseAdmin
        .from('bookings')
        .select(legacyCols)
        .eq('client_id', clientId);
      if (filter === 'upcoming') {
        q2 = q2.gte('starts_at', nowIso).order('starts_at', { ascending: true });
      } else if (filter === 'past') {
        q2 = q2.lt('starts_at', nowIso).order('starts_at', { ascending: false });
      } else {
        q2 = q2.order('starts_at', { ascending: false });
      }
      const retry = await q2;
      data = retry.data;
      error = retry.error;
    }
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
      created_at:        b.created_at,
      tags:              b.tags || [],
      paid_at:           b.paid_at || null
    }));

    if (filter === 'upcoming')  rows = rows.filter(r => r.status !== 'cancelled');
    if (filter === 'cancelled') rows = rows.filter(r => r.status === 'cancelled');

    // Include the calendar timezone so the UI can format starts_at correctly
    // regardless of the operator's browser timezone.
    const { data: cal } = await supabaseAdmin
      .from('booking_calendars').select('timezone').eq('business_id', clientId).maybeSingle();

    return res.status(200).json({
      appointments: rows,
      timezone: cal?.timezone || 'America/Chicago'
    });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, status, tags, mark_paid, mark_unpaid } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });

    // Tag-only / paid-only patches don't need a status. Validate the right
    // path here so the rest of the handler can assume the inputs that apply.
    const isStatusUpdate = !!status;
    const isTagUpdate    = Array.isArray(tags);
    const isPaidUpdate   = mark_paid === true || mark_unpaid === true;
    if (!isStatusUpdate && !isTagUpdate && !isPaidUpdate) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }
    if (isStatusUpdate && !ALLOWED_PORTAL_STATUSES.has(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }

    // Tag / paid updates write directly and return; they don't go through
    // the widget cancel flow.
    if (isTagUpdate || isPaidUpdate) {
      const patch = {};
      if (isTagUpdate) {
        // Sanitize: trim, dedupe, keep ≤ 30 chars per tag, max 20 tags.
        patch.tags = [...new Set(
          tags.map(t => String(t).trim()).filter(t => t && t.length <= 30)
        )].slice(0, 20);
      }
      if (mark_paid === true)   patch.paid_at = new Date().toISOString();
      if (mark_unpaid === true) patch.paid_at = null;

      // Read the booking's originating lead_id before the update so we
      // can cancel nudges for that lead when this booking is marked paid.
      const { data: booking } = await supabaseAdmin
        .from('bookings').select('lead_id').eq('id', id).eq('client_id', clientId).maybeSingle();

      const { data, error } = await supabaseAdmin
        .from('bookings').update(patch)
        .eq('id', id).eq('client_id', clientId)
        .select('id, tags, paid_at, lead_id').single();
      if (error) return res.status(400).json({ error: error.message });

      // Cancel nudges + flag the originating lead as paid + tag it
      // Current Client so future blasts/nudges treat them correctly.
      let cancelled_nudges = 0;
      const blockTag = (patch.tags || []).some(t => ['Do Not Contact', 'Current Client', 'Paid'].includes(t));
      if (booking?.lead_id && (mark_paid === true || blockTag)) {
        if (mark_paid === true) {
          // Propagate paid_at + tags to the lead so the Leads tab metric
          // and the cron's lead-level guard both see the conversion.
          const { data: leadCur } = await supabaseAdmin
            .from('leads').select('tags').eq('id', booking.lead_id).maybeSingle();
          const mergedTags = [...new Set([
            ...((leadCur?.tags || []).filter(t => t !== 'Free Trial')),
            'Paid', 'Current Client'
          ])];
          await supabaseAdmin.from('leads')
            .update({ paid_at: new Date().toISOString(), tags: mergedTags })
            .eq('id', booking.lead_id);
        }
        const { data: cancelled } = await supabaseAdmin
          .from('nudge_queue')
          .update({ failed_reason: 'lead_converted_or_blocked' })
          .eq('lead_id', booking.lead_id)
          .is('sent_at', null)
          .is('failed_reason', null)
          .select('id');
        cancelled_nudges = (cancelled || []).length;
      }
      return res.status(200).json({ appointment: data, cancelled_nudges });
    }

    // Tenant ownership check before any state change. The widget's
    // /api/cancel endpoint accepts any booking_id with no auth, so we
    // verify ownership here in the portal before delegating to it.
    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('bookings')
      .select('id, client_id')
      .eq('id', id)
      .eq('client_id', clientId)
      .maybeSingle();
    if (existingErr) return res.status(500).json({ error: existingErr.message });
    if (!existing)   return res.status(404).json({ error: 'booking_not_found' });

    // Cancellation path: delegate to the public booking widget's
    // /api/cancel endpoint (book.theflexfacility.com/api/cancel) so
    //   1. the customer gets the same SMS template + Twilio sender they
    //      already received their original confirmation from,
    //   2. Coach Kenny gets a parallel notification SMS,
    //   3. the matching time_slots row gets reopened.
    // The widget endpoint updates the bookings row itself, so we don't
    // need to also write here on success. Falls back to a direct DB
    // update if the widget call fails (so cancellation still happens
    // even if the widget is unreachable, just without SMS).
    if (status === 'cancelled') {
      const cancelUrl = process.env.FLEX_BOOKING_CANCEL_URL
        || 'https://book.theflexfacility.com/api/cancel';
      try {
        const widgetRes = await fetch(cancelUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ booking_id: id })
        });
        if (widgetRes.ok) {
          return res.status(200).json({
            appointment: { id, status: 'cancelled' },
            sms_sent: true
          });
        }
        const widgetBody = await widgetRes.text().catch(() => '');
        console.warn('[bookings] widget cancel returned', widgetRes.status, widgetBody);
      } catch (e) {
        console.warn('[bookings] widget cancel fetch error:', e.message);
      }
      // Fall through to direct DB update if the widget call failed.
    }

    // Direct DB update path. Used for confirmed/no_show transitions and
    // as the fallback if the widget cancel call fails. Translates to the
    // Title-cased form the widget uses for consistency.
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
      appointment: { id: data.id, status: dbStatusToPortal(data.status) },
      sms_sent: false
    });
  }
}
