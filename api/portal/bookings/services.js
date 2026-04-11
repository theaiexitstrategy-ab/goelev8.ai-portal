// Booking services CRUD — tenant-scoped (Phase 3 of the booking unification).
//
// Reads from / writes to public.booking_services as recreated in migration
// 0018. Schema: client_id (FK to clients), key (machine slug, unique per
// client), name, full_name, btn_text, max_per_slot, info_title, info_note,
// sort_order, is_active. The widget at book.theflexfacility.com reads this
// table via the flex-booking-calendar /api/services endpoint added in
// Phase 2 and falls back to its hardcoded SESSIONS object on any failure.
//
// GET   — list services for the authed client, ordered by sort_order.
// POST  — create a service. `key` is auto-derived from `name` if omitted.
// PATCH — update by id, scoped by client_id. Soft delete via is_active=false.
//
// No DELETE: status transitions only — same convention as the rest of the
// bookings endpoints.

import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';

// Slugify "Personal Training" → "personal-training" for the `key` column
// when the caller doesn't supply one. Restricted to lowercase ASCII +
// dashes so it's safe to use anywhere a machine identifier is expected.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;
  if (!clientId) return res.status(403).json({ error: 'no_client_assigned' });

  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('booking_services')
      .select('id, client_id, key, name, full_name, btn_text, max_per_slot, info_title, info_note, sort_order, is_active, created_at, updated_at')
      .eq('client_id', clientId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ services: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const name = (body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name_required' });
    const full_name = (body.full_name || name).trim();
    let key = (body.key || '').trim();
    if (!key) key = slugify(name);
    if (!key) return res.status(400).json({ error: 'key_could_not_be_derived' });

    const max_per_slot =
      body.max_per_slot === '' || body.max_per_slot == null
        ? null
        : (Number.isFinite(+body.max_per_slot) ? +body.max_per_slot : null);
    const sort_order = Number.isFinite(+body.sort_order) ? +body.sort_order : 0;

    const { data, error } = await supabaseAdmin
      .from('booking_services')
      .insert({
        client_id:    clientId,
        key,
        name,
        full_name,
        btn_text:     typeof body.btn_text   === 'string' ? body.btn_text.trim()   || null : null,
        max_per_slot,
        info_title:   typeof body.info_title === 'string' ? body.info_title.trim() || null : null,
        info_note:    typeof body.info_note  === 'string' ? body.info_note.trim()  || null : null,
        sort_order,
        is_active:    true
      })
      .select()
      .single();
    if (error) {
      // Surface the unique-key violation as a user-friendly message — most
      // common create failure when two services share a slugified name.
      if (error.code === '23505') {
        return res.status(409).json({ error: 'key_already_exists', detail: 'A service with this key already exists for your account.' });
      }
      return res.status(400).json({ error: error.message });
    }
    return res.status(201).json({ service: data });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });

    // Whitelist writable fields. `key` and `client_id` are intentionally not
    // patchable: changing the key would break the widget's SESSIONS lookup,
    // and client_id is the tenant scope.
    const patch = {};
    if (typeof body.name        === 'string') patch.name        = body.name.trim();
    if (typeof body.full_name   === 'string') patch.full_name   = body.full_name.trim();
    if (typeof body.btn_text    === 'string') patch.btn_text    = body.btn_text.trim() || null;
    if (typeof body.info_title  === 'string') patch.info_title  = body.info_title.trim() || null;
    if (typeof body.info_note   === 'string') patch.info_note   = body.info_note.trim() || null;
    if (Number.isFinite(+body.sort_order))    patch.sort_order  = +body.sort_order;
    if (typeof body.is_active   === 'boolean') patch.is_active  = body.is_active;
    // max_per_slot can be null (unlimited) or a positive integer.
    if (body.max_per_slot === null || body.max_per_slot === '') {
      patch.max_per_slot = null;
    } else if (Number.isFinite(+body.max_per_slot)) {
      patch.max_per_slot = +body.max_per_slot;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'nothing_to_update' });
    }

    const { data, error } = await supabaseAdmin
      .from('booking_services')
      .update(patch)
      .eq('id', id)
      .eq('client_id', clientId)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ service: data });
  }
}
