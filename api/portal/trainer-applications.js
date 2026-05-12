// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Portal-side endpoint for the Trainer Applications feature. Lists +
// counts trainer applications for the authed tenant and lets operators
// update the status per row.
//
// Lives in its own table (public.trainer_applications) and on its own
// tab — completely separate from the public.applications table (artist
// applications) and public.leads. Submissions originate from
// theflexfacility.com/trainers via /api/trainer-apply.
//
// The trainer_applications table keys off a text client_id (defaults to
// 'flex-facility') instead of a uuid FK so the public site can post
// without knowing internal client uuids. This handler maps the authed
// tenant's clients.slug to that text id (matches applications.js).
//
// GET   /api/portal/trainer-applications              — list + per-status counts
// GET   /api/portal/trainer-applications?status=new   — filter to one status
// PATCH /api/portal/trainer-applications              — body: { id, status }

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const VALID_STATUSES = ['new', 'reviewed', 'interview', 'hired', 'declined'];

// Mirrors candidateClientIdsFor() in applications.js — same reasons:
// the public site might post with the uuid, the slug, or an
// underscored variant, and all three should resolve to this tenant.
function candidateClientIdsFor(clientUuid, slug) {
  const s = String(slug || '').trim();
  const set = new Set();
  if (clientUuid) set.add(String(clientUuid));
  if (s) {
    set.add(s);
    if (s.includes('-')) set.add(s.replace(/-/g, '_'));
    if (s.includes('_')) set.add(s.replace(/_/g, '-'));
  }
  return [...set].filter(Boolean);
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  if (!ctx.clientId) return res.status(403).json({ error: 'no_client_context' });

  const { data: clientRow } = await supabaseAdmin
    .from('clients').select('id, slug').eq('id', ctx.clientId).maybeSingle();
  const candidates = candidateClientIdsFor(clientRow?.id, clientRow?.slug);
  if (!candidates.length) return res.status(403).json({ error: 'no_client_slug' });

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const status = (url.searchParams.get('status') || '').trim();

    let q = supabaseAdmin.from('trainer_applications').select('*').in('client_id', candidates);
    if (status && status !== 'all') q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
    if (error && /relation .*trainer_applications.* does not exist/i.test(error.message)) {
      return res.status(200).json({
        trainer_applications: [],
        counts: { all: 0, new: 0, reviewed: 0, interview: 0, hired: 0, declined: 0 },
        setup_required: true
      });
    }
    if (error) return res.status(500).json({ error: error.message });

    const counts = { all: 0, new: 0, reviewed: 0, interview: 0, hired: 0, declined: 0 };
    const { data: all } = await supabaseAdmin.from('trainer_applications')
      .select('status').in('client_id', candidates);
    for (const a of (all || [])) {
      counts.all++;
      counts[a.status] = (counts[a.status] || 0) + 1;
    }
    return res.status(200).json({ trainer_applications: data || [], counts });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id } = body || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const patch = {};
    if (typeof body.status === 'string') {
      if (!VALID_STATUSES.includes(body.status)) {
        return res.status(400).json({ error: 'invalid_status', valid: VALID_STATUSES });
      }
      patch.status = body.status;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });

    // Double-scoped update (id + tenant) so an operator from one tenant
    // can't patch another tenant's row even if they guessed the id.
    const { data, error } = await supabaseAdmin.from('trainer_applications')
      .update(patch).eq('id', id).in('client_id', candidates)
      .select('*').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'application_not_found_for_tenant' });
    return res.status(200).json({ trainer_application: data });
  }
}
