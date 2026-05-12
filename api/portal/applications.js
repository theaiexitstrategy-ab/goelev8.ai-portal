// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Portal-side endpoint for the Applications feature. Lists + counts
// applications for the authed tenant and lets operators update the
// status / internal notes per row.
//
// The applications table keys off a text client_id (e.g. 'islay_studios')
// instead of a uuid FK so public marketing sites can post submissions
// without knowing internal client uuids. This handler maps the
// authed tenant's clients.slug to that text id (hyphens → underscores)
// so iSlay's portal sees only iSlay's applications.
//
// GET   /api/portal/applications              — list applications + per-status counts
// GET   /api/portal/applications?status=new   — filter to one status
// PATCH /api/portal/applications              — body: { id, status?, notes? }

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const VALID_STATUSES = ['new', 'reviewed', 'interview', 'hired', 'declined'];

// Derive every client_id format the public form might have used,
// past or present:
//   - the tenant's uuid (legacy: column was uuid before migration 0027+)
//   - the natural slug   ('islay-studios')
//   - the underscored slug ('islay_studios') — original spec example
// Any insert matching one of these belongs to this tenant, so the
// portal accepts all three when listing + patching. No data migration
// or public-form rewrite required — new submissions in any of these
// formats land on the right tenant automatically.
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

  // Resolve the authed tenant's slug + uuid for the candidate lookup.
  const { data: clientRow } = await supabaseAdmin
    .from('clients').select('id, slug').eq('id', ctx.clientId).maybeSingle();
  const candidates = candidateClientIdsFor(clientRow?.id, clientRow?.slug);
  if (!candidates.length) return res.status(403).json({ error: 'no_client_slug' });

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const status = (url.searchParams.get('status') || '').trim();

    // List query — optionally filtered by status. Tolerant if the
    // applications table hasn't been migrated yet — returns an empty
    // list instead of a 500 so the new tab doesn't crash on a stale
    // schema.
    let q = supabaseAdmin.from('applications').select('*').in('client_id', candidates);
    if (status && status !== 'all') q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
    if (error && /relation .*applications.* does not exist/i.test(error.message)) {
      return res.status(200).json({ applications: [], counts: { all: 0, new: 0, reviewed: 0, interview: 0, hired: 0, declined: 0 }, setup_required: true });
    }
    if (error) return res.status(500).json({ error: error.message });

    // Per-status counts for the filter chip badges. A second small
    // query so the filtered list above doesn't lose visibility into
    // siblings outside the current filter.
    const counts = { all: 0, new: 0, reviewed: 0, interview: 0, hired: 0, declined: 0 };
    const { data: all } = await supabaseAdmin.from('applications')
      .select('status').in('client_id', candidates);
    for (const a of (all || [])) {
      counts.all++;
      counts[a.status] = (counts[a.status] || 0) + 1;
    }
    return res.status(200).json({ applications: data || [], counts });
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
    if (typeof body.notes === 'string') patch.notes = body.notes;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing_to_update' });

    // Update is double-scoped: id AND any of the candidate client_id
    // values. Prevents an operator from one tenant patching another
    // tenant's application row even if they guessed the id.
    const { data, error } = await supabaseAdmin.from('applications')
      .update(patch).eq('id', id).in('client_id', candidates)
      .select('*').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'application_not_found_for_tenant' });
    return res.status(200).json({ application: data });
  }
}
