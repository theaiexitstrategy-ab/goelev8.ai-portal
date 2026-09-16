// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Tenant-authed read + light-write for the generic experience
// bookings platform. Used by the portal SPA's KB (Konquered Balance)
// Overview / Bookings / Leads tabs — and by any future experience-
// booking tenant that shares this schema.
//
// Auth: master admin OR the tenant owner/admin who owns the
// requested client (via client_users). Reject anything else.
//
// GET  /api/portal/experience-bookings?client=<slug>&status=&from=&to=&counts_only=1
//                                       &view=active|archived|all
//   → { rows, count, counts, currentPeriod }
//   view defaults to 'active' (archived rows hidden from the listing).
//
// PATCH /api/portal/experience-bookings   { id, status?, notes? }
//                                         { id, archive: true | unarchive: true }
//   → { ok, row }   (used by the "Mark cancelled" / notes / archive controls)
//
// ---- The three ways a row can leave the default list --------------
//   status='cancelled'  the event was called off. A fact about the guest.
//   archived_at         the event is finished and filed away. Still real,
//                       still counted in deposits + fees + every total.
//   deleted_at          the row should never have existed (test rows,
//                       duplicates). Leaves every count and every total.
// Only deleted_at changes the money figures. Archiving is filing, not
// erasing — see migration 0047 for why these are separate columns.
//
// DELETE /api/portal/experience-bookings  { id }
//   → { ok, soft_deleted: true }
//   Soft-delete (migration 0046) — sets deleted_at and drops the row out
//   of every read and count. Distinct from PATCH status='cancelled':
//   cancelling records what happened to a guest, deleting removes a row
//   that should never have been in the ledger (test submissions,
//   duplicates). Recoverable by clearing deleted_at; never hard-deletes,
//   because these rows carry the Stripe ids for money that moved.

import { supabaseAdmin } from '../../lib/supabase.js';
import { requireUser } from '../../lib/auth.js';

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function resolveClientId(ctx, url) {
  // Precedence: ?client=<slug|uuid> URL param → x-admin-as-client
  // header (arrives as ctx.clientId) → error. See api/portal/
  // reviews.js resolveClientId for the shared reasoning.
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

  const q = url.searchParams;
  const countsOnly = q.get('counts_only') === '1';
  const status     = q.get('status');
  // active (default) | archived | all. Unknown values fall back to
  // 'active' rather than erroring — a stale bookmark shouldn't 400.
  const viewParam  = q.get('view');
  const view       = ['archived', 'all'].includes(viewParam) ? viewParam : 'active';
  const from       = q.get('from');
  const to         = q.get('to');
  const limit      = Math.min(parseInt(q.get('limit')  || '200', 10) || 200, 500);
  const offset     = Math.max(parseInt(q.get('offset') || '0',   10) || 0, 0);

  // Soft-deleted rows are invisible to every read AND every count —
  // deleting a row that still moved the "Confirmed this month" tile
  // would look broken. Tolerant of a project that hasn't run 0046 yet.
  let { data: all, error } = await supabaseAdmin
    .from('experience_bookings')
    .select('*')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error && /column .*deleted_at.* does not exist/i.test(error.message)) {
    const retry = await supabaseAdmin
      .from('experience_bookings')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    all = retry.data; error = retry.error;
  }
  if (error) return res.status(500).json({ error: error.message });

  // rowsAll deliberately still contains archived rows: every count and
  // every money total below is computed over it, so filing an event away
  // never changes what the tenant earned. Only `rows` (the listing) is
  // narrowed by `view` further down.
  const rowsAll = all || [];
  const archivedCount = rowsAll.filter(r => r.archived_at).length;
  const counts = {
    total:            rowsAll.length,
    archived:         archivedCount,
    lead:             0,
    deposit_pending:  0,
    confirmed:        0,
    refunded:         0,
    cancelled:        0,
    upcoming:         0,
    deposits_cents:   0,
    fees_cents:       0
  };
  const nowMs = Date.now();
  for (const r of rowsAll) {
    if (counts[r.status] != null) counts[r.status]++;
    if (r.event_starts_at && new Date(r.event_starts_at).getTime() > nowMs
        && (r.status === 'confirmed' || r.status === 'deposit_pending')) {
      counts.upcoming++;
    }
    if (r.status === 'confirmed') {
      counts.deposits_cents += r.deposit_cents || 0;
      counts.fees_cents     += r.application_fee_cents || 0;
    }
  }

  // Current-month totals (America/Chicago).
  const monthParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit'
  }).formatToParts(new Date());
  const nowMonth = `${monthParts.find(p => p.type === 'year').value}-${monthParts.find(p => p.type === 'month').value}`;
  let monthConfirmed = 0, monthDeposits = 0;
  for (const r of rowsAll) {
    if (r.status !== 'confirmed') continue;
    const rowMonth = (() => {
      try {
        const p = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago', year: 'numeric', month: '2-digit'
        }).formatToParts(new Date(r.created_at));
        return `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}`;
      } catch { return ''; }
    })();
    if (rowMonth === nowMonth) { monthConfirmed++; monthDeposits += r.deposit_cents || 0; }
  }
  const currentPeriod = {
    period: nowMonth,
    confirmed_count: monthConfirmed,
    deposits_cents:  monthDeposits
  };

  if (countsOnly) return res.status(200).json({ counts, currentPeriod });

  let rows = rowsAll;
  if (view === 'active')   rows = rows.filter(r => !r.archived_at);
  if (view === 'archived') rows = rows.filter(r => !!r.archived_at);
  if (status) rows = rows.filter(r => r.status === status);
  if (from)   rows = rows.filter(r => (r.created_at || '').slice(0, 10) >= from);
  if (to)     rows = rows.filter(r => (r.created_at || '').slice(0, 10) <= to);
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);

  return res.status(200).json({ rows: page, count: total, limit, offset, counts, currentPeriod });
}

async function handlePatch(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const id = String(body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id_required' });

  const { data: existing } = await supabaseAdmin
    .from('experience_bookings').select('id, client_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  // Tenant scope check
  if (!ctx.isAdmin) {
    if (existing.client_id !== ctx.clientId) return res.status(403).json({ error: 'forbidden' });
  }

  const patch = { updated_at: new Date().toISOString() };
  if (body.status && ['cancelled', 'confirmed', 'lead'].includes(body.status)) {
    patch.status = body.status;
    if (body.status === 'cancelled') patch.cancelled_at = new Date().toISOString();
  }
  if (typeof body.goal === 'string') patch.goal = body.goal.slice(0, 2000);
  // Archive is a pure toggle and never touches status — a filed-away
  // event is still 'confirmed', it just isn't in the way any more.
  if (body.archive === true)   patch.archived_at = new Date().toISOString();
  if (body.unarchive === true) patch.archived_at = null;

  const { data: row, error } = await supabaseAdmin
    .from('experience_bookings').update(patch).eq('id', id).select('*').single();
  if (error) {
    if (/column .*archived_at.* does not exist/i.test(error.message)) {
      return res.status(501).json({
        error: 'archive_unavailable',
        detail: 'Run migration 0047_bookings_archive_and_portfolio_link.sql on this project.'
      });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, row });
}

async function handleDelete(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }
  const id = String(body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id_required' });

  // Same ownership gate handlePatch uses: look the row up first, then
  // compare client_id, so a stale or guessed id from one tenant can
  // never touch another's row.
  const { data: existing } = await supabaseAdmin
    .from('experience_bookings').select('id, client_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && existing.client_id !== ctx.clientId) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from('experience_bookings')
    .update({ deleted_at: nowIso, updated_at: nowIso })
    .eq('id', id)
    .eq('client_id', existing.client_id);
  if (error) {
    // 0046 not applied on this project. Say so plainly rather than
    // hard-deleting a row that carries Stripe payment ids — silently
    // destroying the audit trail is worse than refusing.
    if (/column .*deleted_at.* does not exist/i.test(error.message)) {
      return res.status(501).json({
        error: 'soft_delete_unavailable',
        detail: 'Run migration 0046_experience_bookings_soft_delete.sql on this project.'
      });
    }
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, soft_deleted: true });
}

export default async function handler(req, res) {
  if (req.method === 'GET')    return await handleList(req, res);
  if (req.method === 'PATCH')  return await handlePatch(req, res);
  if (req.method === 'DELETE') return await handleDelete(req, res);
  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
