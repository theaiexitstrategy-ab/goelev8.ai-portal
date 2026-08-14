// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Tenant-authed read + light-write for paid events and their signups.
// Backs the portal SPA's Events tab. Deliberately the same shape as
// api/portal/experience-bookings.js — same auth, same resolveClientId
// precedence, same { rows, count, counts } response envelope — so the
// operator UI is a variation on a pattern that already exists rather
// than a new one.
//
// Auth: master admin OR the tenant owner/admin who owns the requested
// client (via client_users).
//
// GET   /api/portal/events?client=<slug>&event_id=&status=&q=&counts_only=1
//         → { events, rows, count, counts }
// PATCH /api/portal/events   { id, status?, ...event fields }
//         → { ok, row }   (edit an event: price, capacity, waiver copy…)

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireUser } from '../../lib/auth.js';
import { quoteEventSeat, resolvePlatformFeePct } from '../../lib/platform-fee.js';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Precedence: ?client=<slug|uuid> → x-admin-as-client (ctx.clientId) →
// error. Lifted verbatim from experience-bookings.js so admin
// impersonation behaves identically across tabs.
async function resolveClientId(ctx, url) {
  if (ctx.isAdmin) {
    const slugOrId = url.searchParams.get('client');
    if (slugOrId && slugOrId !== 'undefined' && slugOrId !== 'null') {
      if (/^[0-9a-f-]{36}$/i.test(slugOrId)) return { clientId: slugOrId };
      const { data } = await supabaseAdmin.from('clients').select('id').eq('slug', slugOrId).maybeSingle();
      if (!data) return { error: 'client_not_found', slug: slugOrId };
      return { clientId: data.id };
    }
    if (ctx.clientId && /^[0-9a-f-]{36}$/i.test(String(ctx.clientId))) {
      return { clientId: ctx.clientId };
    }
    return { error: 'client_slug_required_for_admin' };
  }
  if (!ctx.clientId) return { error: 'no_tenant_context' };
  return { clientId: ctx.clientId };
}

async function handleList(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const resolved = await resolveClientId(ctx, url);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const clientId = resolved.clientId;

  const q          = url.searchParams;
  const countsOnly = q.get('counts_only') === '1';
  const eventId    = q.get('event_id');
  const status     = q.get('status');
  const search     = String(q.get('q') || '').trim().toLowerCase();
  const limit      = Math.min(parseInt(q.get('limit')  || '500', 10) || 500, 1000);
  const offset     = Math.max(parseInt(q.get('offset') || '0',   10) || 0, 0);

  const { data: client } = await supabaseAdmin
    .from('clients').select('id, slug, name, platform_fee_pct, stripe_connected_account_id')
    .eq('id', clientId).maybeSingle();

  const { data: eventsRaw, error: evErr } = await supabaseAdmin
    .from('tenant_events').select('*')
    .eq('client_id', clientId)
    .order('starts_at', { ascending: false });
  if (evErr) return res.status(500).json({ error: evErr.message });

  // Attach the live price breakdown to each event so the operator can see
  // exactly what a buyer pays and what they net, computed from the same
  // helper the checkout endpoint uses rather than restated here.
  const events = (eventsRaw || []).map(ev => ({
    ...ev,
    pricing: quoteEventSeat({
      listPriceCents:           ev.price_cents,
      quantity:                 1,
      platformFeePct:           resolvePlatformFeePct({ platform_fee_pct: ev.platform_fee_pct ?? client?.platform_fee_pct }),
      processingFeeCents:       ev.processing_fee_cents,
      passStripeFeesToCustomer: ev.pass_stripe_fees_to_customer
    }),
    seats_remaining: ev.capacity == null ? null : Math.max(0, ev.capacity - (ev.seats_reserved || 0))
  }));

  const { data: all, error } = await supabaseAdmin
    .from('event_reservations').select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const rowsAll = all || [];
  const counts = {
    total: rowsAll.length,
    pending: 0, confirmed: 0, refunded: 0, cancelled: 0, expired: 0,
    seats_confirmed: 0,
    gross_cents: 0,
    platform_fee_cents: 0,
    waiver_accepted: 0
  };
  for (const r of rowsAll) {
    if (counts[r.status] != null) counts[r.status]++;
    if (r.status === 'confirmed') {
      counts.seats_confirmed    += r.quantity || 1;
      counts.gross_cents        += r.amount_total_cents || 0;
      counts.platform_fee_cents += r.platform_fee_cents || 0;
      if (r.waiver_accepted) counts.waiver_accepted++;
    }
  }

  if (countsOnly) return res.status(200).json({ events, counts });

  let rows = rowsAll;
  if (eventId) rows = rows.filter(r => r.event_id === eventId);
  if (status)  rows = rows.filter(r => r.status === status);
  if (search) {
    rows = rows.filter(r =>
      String(r.attendee_name  || '').toLowerCase().includes(search) ||
      String(r.attendee_email || '').toLowerCase().includes(search) ||
      String(r.attendee_phone || '').toLowerCase().includes(search));
  }
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);

  return res.status(200).json({ events, rows: page, count: total, limit, offset, counts });
}

// Editable event fields. Whitelisted rather than spread from the body so
// a caller can't touch client_id, seats_reserved (owned by the seat
// RPCs), or any of the money columns on existing reservations.
const EVENT_PATCH_FIELDS = [
  'title', 'description', 'status', 'starts_at', 'event_tz', 'duration_min',
  'location_name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
  'price_cents', 'capacity', 'platform_fee_pct', 'processing_fee_cents',
  'pass_stripe_fees_to_customer', 'waiver_required', 'waiver_version',
  'waiver_text', 'image_url'
];

async function handlePatch(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const id = String(body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id_required' });

  const { data: existing } = await supabaseAdmin
    .from('tenant_events').select('id, client_id, waiver_version, waiver_text').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && existing.client_id !== ctx.clientId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const patch = { updated_at: new Date().toISOString() };
  for (const f of EVENT_PATCH_FIELDS) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (patch.status && !['draft', 'published', 'closed', 'cancelled'].includes(patch.status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  // Changing the waiver copy without bumping the version would leave two
  // different texts sharing one version string, which defeats the whole
  // point of recording a version alongside each signature. Reject it and
  // make the operator say which revision this is.
  const textChanged = patch.waiver_text !== undefined && patch.waiver_text !== existing.waiver_text;
  const versionSame = patch.waiver_version === undefined || patch.waiver_version === existing.waiver_version;
  if (textChanged && versionSame) {
    return res.status(400).json({
      error: 'waiver_version_required',
      message: 'Changing the waiver text requires a new waiver_version. Existing signups keep their own snapshot of the copy they accepted; the version string is how you tell the revisions apart later.'
    });
  }

  const { data: row, error } = await supabaseAdmin
    .from('tenant_events').update(patch).eq('id', id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, row });
}

export default async function handler(req, res) {
  if (req.method === 'GET')   return await handleList(req, res);
  if (req.method === 'PATCH') return await handlePatch(req, res);
  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'method_not_allowed' });
}
