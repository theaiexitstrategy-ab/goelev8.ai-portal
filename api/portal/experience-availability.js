// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Tenant-authed CRUD for experience_availability_rules (weekly
// recurring open windows) + experience_availability_blocks (specific
// OOO ranges). Used by the SPA's KB Availability editor to let
// Stephen manage what the konqueredkocktails.com calendar shows
// guests without editing Supabase directly.
//
// Auth: master admin OR the tenant owner/admin (via client_users
// join on the requested client). Same pattern as
// /api/portal/experience-bookings.
//
// Routes:
//   GET    /api/portal/experience-availability?client=<slug>
//     → { rules, blocks }
//   POST   /api/portal/experience-availability?type=rule
//     body: { id?, day_of_week, start_time, end_time,
//             slot_duration_min, experience_key?, active }
//     → { ok, row }
//   POST   /api/portal/experience-availability?type=block
//     body: { id?, starts_at, ends_at, reason? }
//     → { ok, row }
//   DELETE /api/portal/experience-availability?type=rule&id=<uuid>
//   DELETE /api/portal/experience-availability?type=block&id=<uuid>
//     → { ok }

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

async function resolveClientId(ctx, url, body) {
  // Admin can specify ?client=<slug|id>. Tenant users use their
  // own client_id from the auth context.
  if (ctx.isAdmin) {
    const slugOrId = url.searchParams.get('client') || body?.client;
    if (!slugOrId) return { error: 'client_slug_required_for_admin' };
    if (/^[0-9a-f-]{36}$/i.test(slugOrId)) return { clientId: slugOrId };
    const { data } = await supabaseAdmin.from('clients').select('id').eq('slug', slugOrId).maybeSingle();
    if (!data) return { error: 'client_not_found' };
    return { clientId: data.id };
  }
  if (!ctx.clientId) return { error: 'no_tenant_context' };
  return { clientId: ctx.clientId };
}

async function assertOwnership(ctx, clientId, rowClientId) {
  if (ctx.isAdmin) return true;
  return ctx.clientId === rowClientId && rowClientId === clientId;
}

// ── GET: list rules + blocks ────────────────────────────────────
async function handleList(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url, null);
  if (r.error) return res.status(400).json({ error: r.error });

  const [rulesRes, blocksRes] = await Promise.all([
    supabaseAdmin.from('experience_availability_rules').select('*')
      .eq('client_id', r.clientId).order('day_of_week', { ascending: true }).order('start_time', { ascending: true }),
    supabaseAdmin.from('experience_availability_blocks').select('*')
      .eq('client_id', r.clientId).order('starts_at', { ascending: true })
  ]);
  if (rulesRes.error)  return res.status(500).json({ error: rulesRes.error.message });
  if (blocksRes.error) return res.status(500).json({ error: blocksRes.error.message });
  return res.status(200).json({
    rules:  rulesRes.data  || [],
    blocks: blocksRes.data || []
  });
}

// ── POST: upsert rule or block ──────────────────────────────────
async function handlePost(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type');
  if (type !== 'rule' && type !== 'block') return res.status(400).json({ error: 'type_must_be_rule_or_block' });

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  const r = await resolveClientId(ctx, url, body);
  if (r.error) return res.status(400).json({ error: r.error });
  const clientId = r.clientId;

  if (type === 'rule') {
    // Validation
    const dow = Number(body.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'day_of_week_0_to_6' });
    const startTime = String(body.start_time || '').trim();
    const endTime   = String(body.end_time || '').trim();
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(startTime)) return res.status(400).json({ error: 'start_time_hh_mm_required' });
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(endTime))   return res.status(400).json({ error: 'end_time_hh_mm_required' });
    if (endTime <= startTime) return res.status(400).json({ error: 'end_time_must_be_after_start' });
    const slot = Number(body.slot_duration_min);
    if (!Number.isInteger(slot) || slot < 15 || slot > 480) return res.status(400).json({ error: 'slot_duration_15_to_480' });

    const row = {
      client_id:         clientId,
      day_of_week:       dow,
      start_time:        startTime.length === 5 ? startTime + ':00' : startTime,
      end_time:          endTime.length === 5   ? endTime + ':00'   : endTime,
      slot_duration_min: slot,
      experience_key:    body.experience_key ? String(body.experience_key).slice(0, 60) : null,
      active:            body.active === false ? false : true,
      updated_at:        new Date().toISOString()
    };

    if (body.id) {
      const { data: existing } = await supabaseAdmin.from('experience_availability_rules')
        .select('client_id').eq('id', body.id).maybeSingle();
      if (!existing) return res.status(404).json({ error: 'rule_not_found' });
      if (!(await assertOwnership(ctx, clientId, existing.client_id))) return res.status(403).json({ error: 'forbidden' });
      const { data, error } = await supabaseAdmin.from('experience_availability_rules')
        .update(row).eq('id', body.id).select().single();
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, row: data });
    }
    const { data, error } = await supabaseAdmin.from('experience_availability_rules')
      .insert(row).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, row: data });
  }

  // type === 'block'
  const startsAt = String(body.starts_at || '').trim();
  const endsAt   = String(body.ends_at || '').trim();
  if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) return res.status(400).json({ error: 'starts_at_iso_required' });
  if (!endsAt   || Number.isNaN(new Date(endsAt).getTime()))   return res.status(400).json({ error: 'ends_at_iso_required' });
  if (new Date(endsAt) <= new Date(startsAt)) return res.status(400).json({ error: 'ends_at_must_be_after_starts_at' });

  const row = {
    client_id: clientId,
    starts_at: new Date(startsAt).toISOString(),
    ends_at:   new Date(endsAt).toISOString(),
    reason:    body.reason ? String(body.reason).slice(0, 200) : null
  };
  if (body.id) {
    const { data: existing } = await supabaseAdmin.from('experience_availability_blocks')
      .select('client_id').eq('id', body.id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'block_not_found' });
    if (!(await assertOwnership(ctx, clientId, existing.client_id))) return res.status(403).json({ error: 'forbidden' });
    const { data, error } = await supabaseAdmin.from('experience_availability_blocks')
      .update(row).eq('id', body.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true, row: data });
  }
  const { data, error } = await supabaseAdmin.from('experience_availability_blocks')
    .insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true, row: data });
}

// ── DELETE: remove rule or block ────────────────────────────────
async function handleDelete(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const type = url.searchParams.get('type');
  const id   = url.searchParams.get('id');
  if (type !== 'rule' && type !== 'block') return res.status(400).json({ error: 'type_must_be_rule_or_block' });
  if (!id) return res.status(400).json({ error: 'id_required' });

  const table = type === 'rule' ? 'experience_availability_rules' : 'experience_availability_blocks';
  const { data: existing } = await supabaseAdmin.from(table).select('client_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (!ctx.isAdmin && ctx.clientId !== existing.client_id) return res.status(403).json({ error: 'forbidden' });

  const { error } = await supabaseAdmin.from(table).delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  if (req.method === 'GET')    return await handleList(req, res);
  if (req.method === 'POST')   return await handlePost(req, res);
  if (req.method === 'DELETE') return await handleDelete(req, res);
  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'method_not_allowed' });
}
