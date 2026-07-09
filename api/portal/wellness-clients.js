// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Leslie's "Wellness Clients" data surface for the Locs & Wellness Co.
// tenant portal. Reads the locs_* tables (schema:
// c:\Users\aaron\.vscode\goelev8-funnels\supabase\migrations\
//   20260708000000_create_locs_schema.sql) which live in this portal's
// shared Supabase project.
//
// SECURITY MODEL
// - This portal auths via its own bearer token, NOT a Supabase auth
//   session, so it can't satisfy the locs_* RLS from the browser (RLS
//   depends on auth.uid()). Instead:
//     1. Endpoint verifies the caller is authenticated via requireUser
//     2. Endpoint verifies the caller is EITHER master admin OR their
//        tenant (client_users.client_id → clients row) has slug
//        'locs-and-wellness'. Only Leslie's tenant can read clinical
//        data through this endpoint.
//     3. Once gated, we query locs_* with the SERVICE ROLE (supabase
//        Admin), which bypasses RLS. That's the intended pattern; it
//        matches every other admin-gated read in this codebase.
// - Journal photos live in the private locs-journal bucket. This
//   endpoint mints short-lived signed URLs on-demand rather than
//   returning raw paths, so nothing in the response is directly
//   fetchable by an unauthenticated client that copies a URL.
//
// Endpoints:
//   GET /api/portal/wellness-clients                       → roster
//   GET /api/portal/wellness-clients?action=detail&id=X    → full profile

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

const TENANT_SLUG = 'locs-and-wellness';
const JOURNAL_BUCKET = 'locs-journal';
const SIGNED_URL_TTL_SECONDS = 60 * 15; // 15 minutes — long enough for a
                                        // detail view session, short
                                        // enough that a copied URL
                                        // expires before it can be
                                        // shared publicly.

// Gate: caller must be master admin OR the current tenant is L&W.
// Returns { allowed: bool, reason?: string } — allowed=true when the
// caller can see wellness-client data.
async function assertLocsAccess(ctx) {
  if (ctx.isAdmin) return { allowed: true };
  if (!ctx.clientId) return { allowed: false, reason: 'no_tenant_context' };
  const { data: c } = await supabaseAdmin
    .from('clients').select('slug').eq('id', ctx.clientId).maybeSingle();
  if (c?.slug === TENANT_SLUG) return { allowed: true };
  return { allowed: false, reason: 'tenant_not_locs' };
}

// Roster — one row per locs_clients with the derived fields Leslie's
// admin console shows (loc stage, latest concern rating, intake status,
// last journal date). Sorted by most-recently-updated intake so the
// top of the list is the client Leslie most recently touched.
async function listRoster(res) {
  const { data, error } = await supabaseAdmin
    .from('locs_clients')
    .select(`
      id, full_name, email, intake_submitted_at, intake_updated_at,
      locs_loc_profile ( loc_stage, last_retwist_date ),
      locs_intake_scalp_history ( concern_rating, main_concerns ),
      locs_journal_entries ( entry_date )
    `)
    .order('intake_updated_at', { ascending: false, nullsFirst: false });
  if (error) return res.status(500).json({ error: error.message });

  const items = (data || []).map((c) => {
    const loc = Array.isArray(c.locs_loc_profile) ? c.locs_loc_profile[0] : c.locs_loc_profile;
    const scalp = Array.isArray(c.locs_intake_scalp_history)
      ? c.locs_intake_scalp_history[0]
      : c.locs_intake_scalp_history;
    const journalDates = (c.locs_journal_entries || [])
      .map((j) => j.entry_date).filter(Boolean);
    const lastVisit = journalDates.sort().at(-1) || null;
    return {
      id:                 c.id,
      fullName:           c.full_name || null,
      email:              c.email || null,
      locStage:           loc?.loc_stage || null,
      lastRetwistDate:    loc?.last_retwist_date || null,
      concernRating:      scalp?.concern_rating ?? null,
      mainConcerns:       scalp?.main_concerns || [],
      intakeSubmittedAt:  c.intake_submitted_at || null,
      intakeUpdatedAt:    c.intake_updated_at || null,
      lastVisit,
    };
  });
  return res.status(200).json({ count: items.length, items });
}

// Detail — the whole "MyChart for the scalp" payload for one client.
// Read-only (this MVP); the write actions from the source console (add
// pro-assessment / elemental / zone-map / summary / note, toggle
// visible_to_client) are a phase-2 add-on.
async function clientDetail(res, clientId) {
  if (!clientId) return res.status(400).json({ error: 'id_required' });

  const [
    clientR, healthR, scalpR, locR,
    proR, elementalR, zonesR, summariesR, notesR, journalR
  ] = await Promise.all([
    supabaseAdmin.from('locs_clients').select('*').eq('id', clientId).maybeSingle(),
    supabaseAdmin.from('locs_intake_health').select('*').eq('client_id', clientId).maybeSingle(),
    supabaseAdmin.from('locs_intake_scalp_history').select('*').eq('client_id', clientId).maybeSingle(),
    supabaseAdmin.from('locs_loc_profile').select('*').eq('client_id', clientId).maybeSingle(),
    supabaseAdmin.from('locs_pro_assessment').select('*').eq('client_id', clientId).order('assessed_at', { ascending: false }),
    supabaseAdmin.from('locs_elemental_pattern').select('*').eq('client_id', clientId).order('assessed_at', { ascending: false }),
    supabaseAdmin.from('locs_scalp_zone_map').select('*').eq('client_id', clientId).order('assessed_at', { ascending: false }),
    supabaseAdmin.from('locs_scalp_summary').select('*').eq('client_id', clientId).order('assessed_at', { ascending: false }),
    supabaseAdmin.from('locs_admin_notes').select('*').eq('client_id', clientId).order('created_at', { ascending: false }),
    supabaseAdmin.from('locs_journal_entries').select('*').eq('client_id', clientId).order('entry_date', { ascending: false }).limit(40),
  ]);

  if (!clientR.data) return res.status(404).json({ error: 'client_not_found' });

  // Bucket zone-map rows by assessed_at — the source console shows
  // each assessment as a dated snapshot of 7 zones. Sort snapshots
  // newest-first so the current one is at the top of history.
  const zoneSnapshots = Object.values(
    (zonesR.data || []).reduce((acc, z) => {
      (acc[z.assessed_at] ||= { assessedAt: z.assessed_at, zones: {} }).zones[z.zone] = z;
      return acc;
    }, {})
  ).sort((a, b) => (a.assessedAt < b.assessedAt ? 1 : -1));

  // Sign every photo path in the journal so the browser can render
  // <img src=…> without hitting private-bucket 403s. Photos are keyed
  // as `<auth.uid()>/<filename>` per the source schema's storage
  // policy — the admin can read every client's folder.
  const journal = [];
  for (const j of journalR.data || []) {
    const paths = Array.isArray(j.photo_urls) ? j.photo_urls : [];
    const photoUrls = [];
    for (const p of paths) {
      try {
        const { data: signed } = await supabaseAdmin.storage
          .from(JOURNAL_BUCKET).createSignedUrl(p, SIGNED_URL_TTL_SECONDS);
        if (signed?.signedUrl) photoUrls.push(signed.signedUrl);
      } catch { /* skip broken paths — one bad photo doesn't kill the row */ }
    }
    journal.push({ ...j, photo_urls: photoUrls });
  }

  return res.status(200).json({
    client:      clientR.data,
    health:      healthR.data || null,
    scalpHistory: scalpR.data || null,
    locProfile:  locR.data || null,
    journal,
    clinical: {
      proHistory:       proR.data || [],
      elementalHistory: elementalR.data || [],
      zoneSnapshots,
      summaries:        summariesR.data || [],
      notes:            notesR.data || [],
    },
    generatedAt: new Date().toISOString()
  });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;

  const gate = await assertLocsAccess(ctx);
  if (!gate.allowed) return res.status(403).json({ error: 'forbidden', reason: gate.reason });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  if (action === 'detail') {
    const id = url.searchParams.get('id');
    return await clientDetail(res, id);
  }
  return await listRoster(res);
}
