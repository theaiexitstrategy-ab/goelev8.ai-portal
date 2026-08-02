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
//   → { rows, count, counts, currentPeriod }
//
// PATCH /api/portal/experience-bookings   { id, status?, notes? }
//   → { ok, row }   (used by the "Mark cancelled" / notes controls)

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
  const from       = q.get('from');
  const to         = q.get('to');
  const limit      = Math.min(parseInt(q.get('limit')  || '200', 10) || 200, 500);
  const offset     = Math.max(parseInt(q.get('offset') || '0',   10) || 0, 0);

  const { data: all, error } = await supabaseAdmin
    .from('experience_bookings')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const rowsAll = all || [];
  const counts = {
    total:            rowsAll.length,
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

  const { data: row, error } = await supabaseAdmin
    .from('experience_bookings').update(patch).eq('id', id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, row });
}

export default async function handler(req, res) {
  if (req.method === 'GET')   return await handleList(req, res);
  if (req.method === 'PATCH') return await handlePatch(req, res);
  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'method_not_allowed' });
}
