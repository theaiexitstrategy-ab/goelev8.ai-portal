// One-off date blackouts for the booking widget.
//
// Lets a client take a specific date (or window inside a date) off
// without editing their recurring weekly availability templates.
// Will needs Monday off → POST { blocked_date: '2026-06-08' } here
// and the widget at book.willpowerfitnessfactory.com will render
// that day as unavailable. The Tuesday after, Will's normal Monday
// schedule resumes automatically.
//
// GET    /api/portal/bookings/blocks
//   Returns upcoming blocks for the authed tenant. Past blocks are
//   filtered out so the list stays focused.
//
// POST   /api/portal/bookings/blocks
//   Body: { blocked_date: 'YYYY-MM-DD', reason?: string,
//           start_time?: 'HH:MM', end_time?: 'HH:MM' }
//   start_time/end_time both omitted = entire day off.
//
// DELETE /api/portal/bookings/blocks?id=<uuid>
//   Removes one block. Tenant-scoped — can only delete own rows.

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

function normalizeDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  // Round-trip through Date to reject impossible dates (Feb 30 etc).
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

function normalizeTime(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s !== 'string') return null;
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return null;
  return s.length === 5 ? s + ':00' : s;
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;
  if (!clientId) return res.status(403).json({ error: 'no_client_assigned' });

  if (req.method === 'GET') {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await supabaseAdmin
      .from('booking_blocked_dates')
      .select('id, blocked_date, start_time, end_time, reason, created_at')
      .eq('client_id', clientId)
      .gte('blocked_date', today)
      .order('blocked_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: true });
    if (error) {
      // Surface the pending-migration case so the UI can show a clear
      // "Run Verify Migrations to enable Days Off" hint instead of a
      // generic 500 the operator can't act on.
      if (/booking_blocked_dates|does not exist|schema cache/i.test(error.message || '')) {
        return res.status(200).json({ blocks: [], pending_migration: true });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ blocks: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const blocked_date = normalizeDate(body.blocked_date);
    if (!blocked_date) return res.status(400).json({ error: 'blocked_date_required_YYYY-MM-DD' });

    // Reject past dates — there's nothing to block. Allows today since
    // someone might block off the rest of today after a same-day event.
    const today = new Date().toISOString().slice(0, 10);
    if (blocked_date < today) return res.status(400).json({ error: 'cannot_block_past_date' });

    const start_time = body.start_time ? normalizeTime(body.start_time) : null;
    const end_time   = body.end_time   ? normalizeTime(body.end_time)   : null;
    if ((body.start_time && !start_time) || (body.end_time && !end_time)) {
      return res.status(400).json({ error: 'invalid_time_format' });
    }
    if (start_time && end_time && start_time >= end_time) {
      return res.status(400).json({ error: 'end_time_must_be_after_start_time' });
    }

    const insertRow = {
      client_id: clientId,
      blocked_date,
      start_time,
      end_time,
      reason: typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null,
      created_by: ctx.user?.id || null
    };

    // Upsert on the unique (client_id, blocked_date, start_time, end_time)
    // index so re-submitting the same block doesn't error out.
    const { data, error } = await supabaseAdmin
      .from('booking_blocked_dates')
      .insert(insertRow)
      .select('id, blocked_date, start_time, end_time, reason, created_at')
      .single();
    if (error) {
      if (/duplicate key|unique/i.test(error.message)) {
        return res.status(409).json({ error: 'already_blocked' });
      }
      if (/booking_blocked_dates|does not exist|schema cache/i.test(error.message || '')) {
        return res.status(503).json({
          error: 'pending_migration',
          hint: 'Run Verify Migrations in Master Admin to enable Days Off.'
        });
      }
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ block: data });
  }

  if (req.method === 'DELETE') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { error } = await supabaseAdmin
      .from('booking_blocked_dates')
      .delete()
      .eq('id', id)
      .eq('client_id', clientId);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
}
