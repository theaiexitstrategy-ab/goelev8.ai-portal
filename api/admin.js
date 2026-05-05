// Master admin endpoint. Single dispatcher (?action=...) used by the
// hidden /admin section of the SPA. Every action requires a platform admin
// JWT (via lib/auth.requireAdmin). Regular client users hit a flat 403.
//
// Actions:
//   list-clients         GET   — every client + balance + 30d usage
//   client-detail        GET   ?id=<uuid>
//   set-credits          POST  { client_id, delta, reason?, note? }
//   send-as-client       POST  { client_id, to, body }   (free, no debit)
//   create-client        POST  { slug, name, twilio_phone_number?, users:[{email,password,role?}], grant_credits? }
//   billing-pause        POST  { client_id, paused: bool }
//   analytics            GET   — global metrics
//   list-admins          GET
//
// Impersonation does NOT happen here — it's handled transparently by
// lib/auth.requireUser via the x-admin-as-client header on the existing
// /api/portal/* endpoints.

import { requireAdmin, methodGuard, readJson } from '../lib/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { twilioForClient, estimateSegments } from '../lib/twilio.js';

async function listClients(req, res) {
  const { data: clients, error } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, twilio_phone_number, credit_balance, billing_paused, welcome_sms_enabled, stripe_connected_account_id, created_at, tier, conversion_label, business_name, logo_url, brand_color, ga4_property_id')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  // Per-client 30d outbound message count
  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const ids = clients.map((c) => c.id);
  const usage = {};
  const lastActivity = {};
  if (ids.length) {
    const { data: rows } = await supabaseAdmin
      .from('messages')
      .select('client_id, created_at, direction')
      .in('client_id', ids)
      .gte('created_at', since);
    for (const r of rows || []) {
      if (r.direction === 'outbound') usage[r.client_id] = (usage[r.client_id] || 0) + 1;
      const prev = lastActivity[r.client_id];
      if (!prev || new Date(r.created_at) > new Date(prev)) lastActivity[r.client_id] = r.created_at;
    }
    // Also consider leads + bookings for last-activity
    const [leadsR, bkR] = await Promise.all([
      supabaseAdmin.from('leads').select('client_id, created_at').in('client_id', ids).order('created_at', { ascending: false }).limit(500),
      supabaseAdmin.from('bookings').select('client_id, created_at').in('client_id', ids).order('created_at', { ascending: false }).limit(500)
    ]);
    for (const r of (leadsR.data || []).concat(bkR.data || [])) {
      const prev = lastActivity[r.client_id];
      if (!prev || new Date(r.created_at) > new Date(prev)) lastActivity[r.client_id] = r.created_at;
    }
  }

  // Booking calendar custom_domain per client (drives the booking URL the
  // welcome SMS and Vapi assistant emit). Tolerant if the table is empty.
  const bookingDomains = {};
  if (ids.length) {
    const { data: cals } = await supabaseAdmin
      .from('booking_calendars').select('business_id, custom_domain, slug').in('business_id', ids);
    for (const r of cals || []) {
      bookingDomains[r.business_id] = r.custom_domain || (r.slug ? `book.goelev8.ai/${r.slug}` : '');
    }
  }

  return res.status(200).json({
    clients: clients.map((c) => ({
      ...c,
      sent_30d: usage[c.id] || 0,
      last_activity_at: lastActivity[c.id] || null,
      booking_custom_domain: bookingDomains[c.id] || ''
    }))
  });
}

async function clientDetail(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  if (!id) return res.status(400).json({ error: 'id_required' });
  const [{ data: client }, { data: ledger }, { data: users }] = await Promise.all([
    supabaseAdmin.from('clients').select('*').eq('id', id).single(),
    supabaseAdmin.from('credit_ledger').select('*').eq('client_id', id).order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('client_users').select('user_id, role').eq('client_id', id)
  ]);
  if (!client) return res.status(404).json({ error: 'not_found' });
  return res.status(200).json({ client, ledger, users });
}

async function setCredits(req, res, ctx) {
  const body = await readJson(req);
  const { client_id, delta, reason = 'admin_adjust', note } = body || {};
  const n = parseInt(delta, 10);
  if (!client_id || !Number.isFinite(n) || n === 0) {
    return res.status(400).json({ error: 'client_id_and_nonzero_delta_required' });
  }
  // Direct update so admin removals can go below current balance without
  // tripping consume_credits' insufficient_credits check. Clamp at 0.
  const { data: cur, error: curErr } = await supabaseAdmin
    .from('clients').select('id, credit_balance').eq('id', client_id).single();
  if (curErr || !cur) return res.status(404).json({ error: 'client_not_found' });
  const newBal = Math.max(0, (cur.credit_balance || 0) + n);
  const appliedDelta = newBal - (cur.credit_balance || 0);
  const { data: client, error: upErr } = await supabaseAdmin
    .from('clients').update({ credit_balance: newBal })
    .eq('id', client_id).select('id, credit_balance').single();
  if (upErr) return res.status(400).json({ error: upErr.message });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id, delta: appliedDelta, reason,
    ref_id: 'admin:' + ctx.user.email + (note ? ' — ' + note.slice(0, 200) : '')
  });
  return res.status(200).json({ ok: true, client, applied_delta: appliedDelta });
}

async function sendAsClient(req, res, ctx) {
  const body = await readJson(req);
  const { client_id, to, body: text, contact_id } = body || {};
  if (!client_id || (!to && !contact_id) || !text) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const { data: client } = await supabaseAdmin
    .from('clients').select('*').eq('id', client_id).single();
  if (!client) return res.status(404).json({ error: 'client_not_found' });
  if (!client.twilio_phone_number) return res.status(400).json({ error: 'no_twilio_number' });

  let destNumber = to;
  let resolvedContact = null;
  if (contact_id) {
    const { data } = await supabaseAdmin.from('contacts').select('*').eq('id', contact_id).single();
    if (!data) return res.status(404).json({ error: 'contact_not_found' });
    resolvedContact = data;
    destNumber = data.phone;
  }

  const tw = twilioForClient(client);
  let twilioMsg;
  try {
    twilioMsg = await tw.messages.create({
      from: client.twilio_phone_number,
      to: destNumber,
      body: text,
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
    });
  } catch (err) {
    return res.status(502).json({ error: 'twilio_failed', detail: err.message });
  }

  const segments = estimateSegments(text);
  // Logged with credits_charged: 0 so it never affects billing reports.
  await supabaseAdmin.from('messages').insert({
    client_id,
    contact_id: resolvedContact?.id || null,
    direction: 'outbound',
    body: text,
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: destNumber,
    from_number: client.twilio_phone_number,
    credits_charged: 0
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id, delta: 0, reason: 'admin_send_free',
    ref_id: 'admin:' + ctx.user.email + ':' + twilioMsg.sid
  });
  return res.status(200).json({ ok: true, sid: twilioMsg.sid, segments, billed: false });
}

async function createClient(req, res) {
  const body = await readJson(req);
  const { slug, name, twilio_phone_number, users = [], grant_credits = 20 } = body || {};
  if (!slug || !name) return res.status(400).json({ error: 'slug_and_name_required' });
  const { data: existing } = await supabaseAdmin
    .from('clients').select('id').eq('slug', slug).maybeSingle();
  if (existing) return res.status(409).json({ error: 'slug_exists' });

  const { data: client, error } = await supabaseAdmin.from('clients').insert({
    slug, name, twilio_phone_number: twilio_phone_number || null, credit_balance: grant_credits
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });

  if (grant_credits > 0) {
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: client.id, delta: grant_credits, reason: 'trial_grant', ref_id: 'admin_create'
    });
  }

  const created_users = [];
  for (const u of users) {
    if (!u.email || !u.password) continue;
    const { data: au, error: auErr } = await supabaseAdmin.auth.admin.createUser({
      email: u.email, password: u.password, email_confirm: true
    });
    let uid = au?.user?.id;
    if (auErr && /already/i.test(auErr.message)) {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      uid = list.users.find((x) => x.email === u.email)?.id;
    }
    if (!uid) continue;
    await supabaseAdmin.from('client_users').upsert({
      user_id: uid, client_id: client.id, role: u.role || 'owner'
    }, { onConflict: 'user_id,client_id' });
    created_users.push({ email: u.email, user_id: uid });
  }

  return res.status(201).json({ client, users: created_users });
}

async function billingPause(req, res) {
  const body = await readJson(req);
  const { client_id, paused } = body || {};
  if (!client_id || typeof paused !== 'boolean') {
    return res.status(400).json({ error: 'client_id_and_paused_required' });
  }
  const { data, error } = await supabaseAdmin
    .from('clients').update({ billing_paused: paused })
    .eq('id', client_id).select('id, billing_paused').single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ client: data });
}

async function analytics(req, res) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const since7  = new Date(Date.now() - 7  * 86400 * 1000).toISOString();

  const [
    { count: totalClients },
    { count: newClients30 },
    { count: smsThisMonth },
    { data: activeRows },
    { data: revenueRows }
  ] = await Promise.all([
    supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('clients').select('id', { count: 'exact', head: true }).gte('created_at', since30),
    supabaseAdmin.from('messages').select('id', { count: 'exact', head: true })
      .eq('direction', 'outbound').gte('created_at', monthStart.toISOString()),
    supabaseAdmin.from('messages').select('client_id').eq('direction', 'outbound').gte('created_at', since7),
    supabaseAdmin.from('credit_ledger').select('reason, delta, created_at')
      .in('reason', ['purchase', 'auto_reload']).gte('created_at', monthStart.toISOString())
  ]);

  const activeClients7d = new Set((activeRows || []).map((r) => r.client_id)).size;

  // Estimate revenue: pull pack-cents from credit_ledger ref convention if present.
  // Simpler: count purchase rows and assume average. Skipped — give raw counts.
  return res.status(200).json({
    total_clients: totalClients || 0,
    new_clients_30d: newClients30 || 0,
    sms_this_month: smsThisMonth || 0,
    active_clients_7d: activeClients7d,
    purchases_this_month: (revenueRows || []).length
  });
}

async function setTier(req, res) {
  const body = await readJson(req);
  const { client_id, tier } = body || {};
  const VALID_TIERS = ['starter', 'growth', 'custom'];
  if (!client_id || !VALID_TIERS.includes(tier)) {
    return res.status(400).json({ error: 'client_id and valid tier (starter/growth/custom) required' });
  }
  const { data, error } = await supabaseAdmin
    .from('clients').update({ tier })
    .eq('id', client_id).select('id, name, tier').single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ client: data });
}

async function setGa4(req, res) {
  const body = await readJson(req);
  const { client_id, ga4_property_id } = body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const value = (ga4_property_id || '').toString().trim() || null;
  const { data, error } = await supabaseAdmin
    .from('clients').update({ ga4_property_id: value })
    .eq('id', client_id).select('id, name, ga4_property_id').single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ client: data });
}

async function activityFeed(req, res) {
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 1000);

  // Fetch clients, leads, bookings in parallel — service-role bypasses RLS
  // so we get cross-tenant data. This endpoint is admin-gated by the outer
  // handler (requireAdmin), so non-admins can never reach it.
  const [clientsR, leadsR, bookingsR] = await Promise.all([
    supabaseAdmin.from('clients').select('id, slug, name').order('name'),
    supabaseAdmin.from('leads')
      .select('id, client_id, name, phone, email, source, funnel, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    supabaseAdmin.from('bookings')
      .select('id, client_id, service, status, starts_at, created_at, contact_name, contact_phone, contact_email, lead_name')
      .order('created_at', { ascending: false })
      .limit(limit)
  ]);

  if (clientsR.error)  return res.status(500).json({ error: clientsR.error.message });
  // Leads/bookings may fail with a missing-column error on older schemas —
  // surface a friendly empty list rather than 500.
  const leads = leadsR.error ? [] : (leadsR.data || []);
  const bookings = bookingsR.error ? [] : (bookingsR.data || []);

  return res.status(200).json({
    clients:  clientsR.data || [],
    leads,
    bookings,
    errors: {
      leads: leadsR.error?.message || null,
      bookings: bookingsR.error?.message || null
    }
  });
}

async function ensureDefaultClients(req, res) {
  // DLP was a duplicate/acronym for Daniels Legacy Planning. Remove any row
  // matching the stale slug OR literal name so it never re-appears in lists.
  await supabaseAdmin.from('clients').delete().eq('slug', 'dlp').then(() => {}, () => {});
  await supabaseAdmin.from('clients').delete().ilike('name', 'dlp').then(() => {}, () => {});

  const required = [
    { slug: 'goelev8',       name: 'GoElev8.ai',        business_name: 'GoElev8.ai' },
    { slug: 'flex-facility', name: 'The Flex Facility', business_name: 'The Flex Facility LLC' },
    { slug: 'islay-studios', name: 'iSlay Studios',     business_name: 'iSlay Studios LLC' }
  ];
  const { data: existing } = await supabaseAdmin
    .from('clients').select('id, slug, name, business_name');
  const existingSlugs = new Set((existing || []).map(c => c.slug));
  const existingNames = new Set((existing || []).map(c => (c.name || '').toLowerCase()));
  const toInsert = required.filter(r =>
    !existingSlugs.has(r.slug) && !existingNames.has(r.name.toLowerCase())
  );
  let inserted = 0;
  if (toInsert.length) {
    // Try with business_name first; if that column doesn't exist, retry without it
    let { error } = await supabaseAdmin.from('clients').insert(toInsert);
    if (error && /column .*business_name.* does not exist/i.test(error.message)) {
      const trimmed = toInsert.map(({ business_name, ...rest }) => rest);
      ({ error } = await supabaseAdmin.from('clients').insert(trimmed));
    }
    if (error) return res.status(400).json({ error: error.message });
    inserted = toInsert.length;
  }
  // Backfill business_name for any existing rows that are missing it
  const missingBiz = (existing || []).filter(c =>
    required.some(r => r.slug === c.slug) && !c.business_name
  );
  for (const c of missingBiz) {
    const target = required.find(r => r.slug === c.slug);
    if (!target?.business_name) continue;
    await supabaseAdmin.from('clients')
      .update({ business_name: target.business_name })
      .eq('id', c.id)
      .then(() => {}, () => {});
  }
  return res.status(200).json({ ensured: required.length, inserted });
}

// One-shot pending-migrations runner. Calls Supabase Management API
// (https://api.supabase.com/v1/projects/{ref}/database/query) with the
// SUPABASE_ACCESS_TOKEN so the operator can apply schema changes from
// the portal without copy/pasting SQL into the Supabase dashboard.
//
// Each statement runs in its own request and is fully idempotent
// (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP POLICY
// IF EXISTS / CREATE POLICY) so re-running is safe.
// Find duplicate leads (same client + same phone OR same email) and merge
// them into the oldest row. FK references on bookings, vapi_calls,
// messages, and nudge_queue are repointed to the canonical lead before
// the duplicates are deleted, so nothing is orphaned and nothing breaks.
//
// Idempotent — running it twice is a no-op once dupes are gone.
async function dedupeLeads(req, res) {
  const { data: clients } = await supabaseAdmin
    .from('clients').select('id, name');
  let scanned = 0, mergedGroups = 0, deleted = 0;
  const perClient = [];

  for (const c of clients || []) {
    // Tolerate schemas missing paid_at (migration 0023 not yet applied) —
    // retry with the leaner column set if Postgres complains.
    let leads, leadsErr;
    ({ data: leads, error: leadsErr } = await supabaseAdmin
      .from('leads').select('id, name, phone, email, tags, created_at, paid_at')
      .eq('client_id', c.id)
      .order('created_at', { ascending: true }));
    if (leadsErr && /column .*paid_at.* does not exist/i.test(leadsErr.message)) {
      ({ data: leads } = await supabaseAdmin
        .from('leads').select('id, name, phone, email, tags, created_at')
        .eq('client_id', c.id)
        .order('created_at', { ascending: true }));
    }
    if (!leads?.length) continue;
    scanned += leads.length;

    // Group by (phone or email) + first-name so a household sharing
    // one phone (e.g. Levi + Legend Harris) keeps separate lead rows.
    // Anything missing a name rolls into the matching phone/email
    // group regardless (almost certainly the same human, just dropped
    // the name on a re-submit).
    const firstName = (n) => String(n || '').trim().toLowerCase().split(/\s+/)[0] || '';
    const groups = new Map(); // groupKey -> [leads]
    const orphansByPhone = []; // unnamed leads waiting to attach
    const orphansByEmail = [];
    for (const l of leads) {
      const fn = firstName(l.name);
      const phoneKey = (l.phone || '').replace(/[^\d+]/g, '');
      const emailKey = (l.email || '').trim().toLowerCase();
      if (!phoneKey && !emailKey) continue; // nothing to group on
      if (!fn) {
        if (phoneKey) orphansByPhone.push({ key: phoneKey, lead: l });
        else if (emailKey) orphansByEmail.push({ key: emailKey, lead: l });
        continue;
      }
      const key = phoneKey
        ? 'p:' + phoneKey + '|n:' + fn
        : 'e:' + emailKey + '|n:' + fn;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(l);
    }
    // Attach orphans (no-name rows) to the first matching named group
    // by phone/email. If none exists they become their own group.
    for (const { key: phoneKey, lead } of orphansByPhone) {
      const matchKey = [...groups.keys()].find(k => k.startsWith('p:' + phoneKey + '|'));
      if (matchKey) groups.get(matchKey).push(lead);
      else groups.set('p:' + phoneKey + '|n:', [lead]);
    }
    for (const { key: emailKey, lead } of orphansByEmail) {
      const matchKey = [...groups.keys()].find(k => k.startsWith('e:' + emailKey + '|'));
      if (matchKey) groups.get(matchKey).push(lead);
      else groups.set('e:' + emailKey + '|n:', [lead]);
    }
    const allGroups = [...groups.values()].filter(g => g.length > 1);
    let clientMerged = 0, clientDeleted = 0;

    for (const group of allGroups) {
      // Canonical = oldest (lowest created_at). Already at index 0 because
      // the SELECT was ordered ascending.
      const canonical = group[0];
      const dupes = group.slice(1);

      // Union tags + earliest paid_at into canonical
      const allTags = new Set();
      for (const l of group) for (const t of (l.tags || [])) allTags.add(t);
      const earliestPaid = group
        .map(l => l.paid_at).filter(Boolean)
        .sort()[0] || null;
      const patch = {};
      if (allTags.size) patch.tags = Array.from(allTags);
      if (earliestPaid) patch.paid_at = earliestPaid;
      // If canonical is missing name/phone/email, fill from a dupe.
      for (const f of ['name', 'phone', 'email']) {
        if (!canonical[f]) {
          const filler = dupes.find(d => d[f]);
          if (filler) patch[f] = filler[f];
        }
      }
      if (Object.keys(patch).length) {
        await supabaseAdmin.from('leads').update(patch).eq('id', canonical.id);
      }

      // Repoint every FK reference from the dupes to canonical, then
      // delete the dupes.
      const dupeIds = dupes.map(d => d.id);
      for (const tbl of ['bookings', 'vapi_calls', 'messages', 'nudge_queue']) {
        await supabaseAdmin.from(tbl)
          .update({ lead_id: canonical.id })
          .in('lead_id', dupeIds)
          .then(() => {}, () => {}); // tolerant of missing tables
      }
      // Soft-delete the duplicates so they're recoverable from Trash
      // for 30 days. Falls back to hard delete on pre-0024 schemas.
      let delErr;
      ({ error: delErr } = await supabaseAdmin
        .from('leads').update({ deleted_at: new Date().toISOString() })
        .in('id', dupeIds));
      if (delErr && /column .*deleted_at.* does not exist/i.test(delErr.message)) {
        const retry = await supabaseAdmin.from('leads').delete().in('id', dupeIds);
        delErr = retry.error;
      }
      if (!delErr) {
        clientMerged++;
        clientDeleted += dupes.length;
      }
    }

    if (clientMerged) {
      mergedGroups += clientMerged;
      deleted += clientDeleted;
      perClient.push({ client: c.name, groups_merged: clientMerged, dupes_removed: clientDeleted });
    }
  }

  return res.status(200).json({
    scanned_leads: scanned,
    merged_groups: mergedGroups,
    duplicates_removed: deleted,
    per_client: perClient
  });
}

// Make sure every tenant's portal_tabs includes the canonical set of
// tabs that the unified SPA supports. Idempotent: only ADDS missing
// tabs to each tenant's existing list (never removes tabs an operator
// has explicitly hidden). Use this after shipping a new tab to push
// it across every tenant in one click.
// Trash endpoints — soft-deleted records within the 30-day recovery
// window. Cross-tenant for the platform admin; the per-tenant Trash
// view in the portal UI scopes via ctx.clientId.
const TRASH_TABLES = {
  leads:    { cols: 'id, client_id, name, phone, email, source, created_at, deleted_at' },
  contacts: { cols: 'id, client_id, name, phone, email, source, created_at, deleted_at' },
  bookings: { cols: 'id, client_id, lead_name, phone, email, service, starts_at, status, created_at, deleted_at' }
};

async function listTrash(req, res, ctx) {
  const url = new URL(req.url, 'http://x');
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const out = {};
  for (const [table, def] of Object.entries(TRASH_TABLES)) {
    const r = await supabaseAdmin.from(table).select(def.cols)
      .not('deleted_at', 'is', null)
      .gte('deleted_at', cutoff)
      .order('deleted_at', { ascending: false })
      .limit(500);
    if (r.error && /column .*deleted_at.* does not exist/i.test(r.error.message)) {
      out[table] = [];
      continue;
    }
    if (r.error) {
      out[table] = { error: r.error.message };
      continue;
    }
    out[table] = r.data || [];
  }
  // Resolve client names so the UI can label each row.
  const ids = new Set();
  for (const t of Object.values(out)) {
    if (Array.isArray(t)) for (const r of t) if (r.client_id) ids.add(r.client_id);
  }
  let clientNames = {};
  if (ids.size) {
    const { data: cs } = await supabaseAdmin
      .from('clients').select('id, name, business_name').in('id', [...ids]);
    for (const c of cs || []) clientNames[c.id] = c.business_name || c.name;
  }
  return res.status(200).json({
    cutoff_iso: cutoff,
    leads:    Array.isArray(out.leads)    ? out.leads    : [],
    contacts: Array.isArray(out.contacts) ? out.contacts : [],
    bookings: Array.isArray(out.bookings) ? out.bookings : [],
    client_names: clientNames
  });
}

async function restoreTrashRecord(req, res) {
  const body = await readJson(req);
  const { type, id, permanent } = body || {};
  if (!type || !id) return res.status(400).json({ error: 'type_and_id_required' });
  if (!TRASH_TABLES[type]) return res.status(400).json({ error: 'invalid_type' });
  if (permanent === true) {
    const { error } = await supabaseAdmin.from(type).delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true, action: 'permanently_deleted' });
  }
  const { error } = await supabaseAdmin.from(type)
    .update({ deleted_at: null }).eq('id', id);
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ ok: true, action: 'restored' });
}

async function ensurePortalTabs(req, res) {
  const STANDARD_TABS = [
    'overview', 'leads', 'messages', 'contacts', 'blasts',
    'nudges', 'bookings', 'analytics', 'settings'
  ];
  const { data: clients } = await supabaseAdmin
    .from('clients').select('id, slug, name, portal_tabs');
  let updated = 0;
  const perClient = [];
  for (const c of clients || []) {
    const current = Array.isArray(c.portal_tabs) ? c.portal_tabs : [];
    const missing = STANDARD_TABS.filter(t => !current.includes(t));
    if (!missing.length) continue;
    // Preserve original order, append missing tabs at the end so any
    // operator-defined ordering survives.
    const next = current.length ? [...current, ...missing] : STANDARD_TABS.slice();
    const { error } = await supabaseAdmin.from('clients')
      .update({ portal_tabs: next }).eq('id', c.id);
    if (!error) {
      updated++;
      perClient.push({ client: c.name || c.slug, added_tabs: missing });
    }
  }
  return res.status(200).json({
    standard_tabs: STANDARD_TABS,
    tenants_updated: updated,
    per_client: perClient
  });
}

async function applyPendingMigrations(req, res) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    return res.status(400).json({
      error: 'SUPABASE_ACCESS_TOKEN env var not set in Vercel — add a personal access token from https://supabase.com/dashboard/account/tokens, then redeploy.'
    });
  }
  // Project ref derived from SUPABASE_URL (https://<ref>.supabase.co).
  let projectRef = null;
  try {
    const u = new URL(process.env.SUPABASE_URL || '');
    projectRef = u.host.split('.')[0];
  } catch {}
  if (!projectRef) return res.status(400).json({ error: 'Could not derive project ref from SUPABASE_URL' });

  const statements = [
    // ----- 0020: clients.stripe_secret_key -----
    `ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS stripe_secret_key text;`,
    `COMMENT ON COLUMN public.clients.stripe_secret_key IS 'Client own Stripe secret key (sk_live_...) for syncing sales from their Stripe account into the portal.';`,

    // ----- 0021: admin RLS on clients -----
    `ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS clients_select_all     ON public.clients;`,
    `DROP POLICY IF EXISTS "clients are public"   ON public.clients;`,
    `DROP POLICY IF EXISTS clients_admin_select   ON public.clients;`,
    `CREATE POLICY clients_admin_select ON public.clients
       FOR SELECT TO authenticated
       USING ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));`,
    `DROP POLICY IF EXISTS clients_member_select  ON public.clients;`,
    `CREATE POLICY clients_member_select ON public.clients
       FOR SELECT TO authenticated
       USING (id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid()));`,
    `DROP POLICY IF EXISTS clients_admin_write ON public.clients;`,
    `CREATE POLICY clients_admin_write ON public.clients
       FOR ALL TO authenticated
       USING ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()))
       WITH CHECK ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));`,

    // ----- 0022: Twilio reserve -----
    `ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS twilio_reserve_cents bigint NOT NULL DEFAULT 0;`,
    `CREATE TABLE IF NOT EXISTS public.twilio_reserves (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
       delta_cents bigint NOT NULL,
       reason text NOT NULL,
       ref_id text,
       pack text,
       segments integer,
       amount_cents integer,
       created_at timestamptz NOT NULL DEFAULT now()
     );`,
    `CREATE INDEX IF NOT EXISTS twilio_reserves_client_idx ON public.twilio_reserves(client_id, created_at DESC);`,
    `ALTER TABLE public.twilio_reserves ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS twilio_reserves_member_select ON public.twilio_reserves;`,
    `CREATE POLICY twilio_reserves_member_select ON public.twilio_reserves
       FOR SELECT TO authenticated
       USING (client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid())
              OR (auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));`,
    `CREATE OR REPLACE FUNCTION public.debit_twilio_reserve_on_sms()
     RETURNS trigger LANGUAGE plpgsql AS $func$
     DECLARE
       v_per_segment_cents int;
       v_segments int;
       v_cost int;
     BEGIN
       IF NEW.delta < 0
          AND NEW.reason IN ('sms_send', 'sms_blast', 'welcome_sms', 'nudge_send', 'islay_sms')
       THEN
         v_segments := -NEW.delta;
         BEGIN
           v_per_segment_cents := COALESCE(current_setting('app.twilio_cost_cents', true)::int, 1);
         EXCEPTION WHEN others THEN
           v_per_segment_cents := 1;
         END;
         v_cost := v_segments * v_per_segment_cents;
         UPDATE public.clients SET twilio_reserve_cents = COALESCE(twilio_reserve_cents, 0) - v_cost WHERE id = NEW.client_id;
         INSERT INTO public.twilio_reserves (client_id, delta_cents, reason, ref_id, segments)
         VALUES (NEW.client_id, -v_cost, NEW.reason, NEW.ref_id, v_segments);
       END IF;
       RETURN NEW;
     END;
     $func$;`,
    `DROP TRIGGER IF EXISTS credit_ledger_debit_reserve ON public.credit_ledger;`,
    `CREATE TRIGGER credit_ledger_debit_reserve
       AFTER INSERT ON public.credit_ledger
       FOR EACH ROW EXECUTE FUNCTION public.debit_twilio_reserve_on_sms();`,
    `CREATE OR REPLACE FUNCTION public.adjust_twilio_reserve(
       p_client_id uuid, p_delta_cents bigint, p_reason text,
       p_ref_id text DEFAULT NULL, p_pack text DEFAULT NULL,
       p_segments integer DEFAULT NULL, p_amount_cents integer DEFAULT NULL
     ) RETURNS bigint LANGUAGE plpgsql AS $func$
     DECLARE v_new_balance bigint;
     BEGIN
       UPDATE public.clients SET twilio_reserve_cents = COALESCE(twilio_reserve_cents, 0) + p_delta_cents
         WHERE id = p_client_id RETURNING twilio_reserve_cents INTO v_new_balance;
       INSERT INTO public.twilio_reserves (client_id, delta_cents, reason, ref_id, pack, segments, amount_cents)
         VALUES (p_client_id, p_delta_cents, p_reason, p_ref_id, p_pack, p_segments, p_amount_cents);
       RETURN v_new_balance;
     END;
     $func$;`,

    // ----- 0023: tags + paid_at -----
    `ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';`,
    `ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS paid_at timestamptz;`,
    `ALTER TABLE public.leads    ADD COLUMN IF NOT EXISTS paid_at timestamptz;`,
    `CREATE INDEX IF NOT EXISTS bookings_tags_gin    ON public.bookings   USING gin(tags);`,
    `CREATE INDEX IF NOT EXISTS contacts_tags_gin    ON public.contacts   USING gin(tags);`,
    `CREATE INDEX IF NOT EXISTS leads_tags_gin_idx   ON public.leads      USING gin(tags);`,
    `CREATE INDEX IF NOT EXISTS bookings_paid_at_idx ON public.bookings(client_id, paid_at) WHERE paid_at IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS leads_paid_at_idx    ON public.leads(client_id, paid_at)    WHERE paid_at IS NOT NULL;`,

    // ----- 0024: soft-delete recovery -----
    `ALTER TABLE public.leads    ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`,
    `ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`,
    `ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS deleted_at timestamptz;`,
    `CREATE INDEX IF NOT EXISTS leads_deleted_at_idx    ON public.leads(client_id, deleted_at)    WHERE deleted_at IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS contacts_deleted_at_idx ON public.contacts(client_id, deleted_at) WHERE deleted_at IS NOT NULL;`,
    `CREATE INDEX IF NOT EXISTS bookings_deleted_at_idx ON public.bookings(client_id, deleted_at) WHERE deleted_at IS NOT NULL;`,

    // ----- 0025: customer avatar URL on leads -----
    `ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS avatar_url text;`,

    // ----- 0026: AFTER-INSERT trigger on bookings cancels pending nudges -----
    `CREATE OR REPLACE FUNCTION public.cancel_nudges_on_booking()
     RETURNS trigger LANGUAGE plpgsql AS $func$
     BEGIN
       IF NEW.lead_id IS NOT NULL THEN
         UPDATE public.nudge_queue
            SET failed_reason = 'booking_made'
          WHERE lead_id = NEW.lead_id
            AND sent_at IS NULL
            AND failed_reason IS NULL;
         UPDATE public.leads
            SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['Booked', 'Current Client'])))
          WHERE id = NEW.lead_id;
       END IF;
       IF NEW.phone IS NOT NULL AND NEW.phone <> '' THEN
         UPDATE public.nudge_queue nq
            SET failed_reason = 'booking_made'
           FROM public.leads l
          WHERE nq.lead_id = l.id
            AND l.client_id = NEW.client_id
            AND l.phone = NEW.phone
            AND nq.sent_at IS NULL
            AND nq.failed_reason IS NULL;
         UPDATE public.leads
            SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['Booked', 'Current Client'])))
          WHERE client_id = NEW.client_id AND phone = NEW.phone;
       END IF;
       IF NEW.email IS NOT NULL AND NEW.email <> '' THEN
         UPDATE public.nudge_queue nq
            SET failed_reason = 'booking_made'
           FROM public.leads l
          WHERE nq.lead_id = l.id
            AND l.client_id = NEW.client_id
            AND lower(l.email) = lower(NEW.email)
            AND nq.sent_at IS NULL
            AND nq.failed_reason IS NULL;
         UPDATE public.leads
            SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['Booked', 'Current Client'])))
          WHERE client_id = NEW.client_id AND lower(email) = lower(NEW.email);
       END IF;
       RETURN NEW;
     END;
     $func$;`,
    `DROP TRIGGER IF EXISTS bookings_cancel_nudges ON public.bookings;`,
    `CREATE TRIGGER bookings_cancel_nudges
       AFTER INSERT ON public.bookings
       FOR EACH ROW EXECUTE FUNCTION public.cancel_nudges_on_booking();`
  ];

  const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  const results = [];
  let success = 0, failed = 0;
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql })
      });
      const text = await r.text();
      if (r.ok) {
        results.push({ i, ok: true, sql_preview: sql.slice(0, 60) + '…' });
        success++;
      } else {
        results.push({ i, ok: false, status: r.status, error: text.slice(0, 300), sql_preview: sql.slice(0, 60) + '…' });
        failed++;
      }
    } catch (e) {
      results.push({ i, ok: false, error: e.message, sql_preview: sql.slice(0, 60) + '…' });
      failed++;
    }
  }
  return res.status(200).json({ project_ref: projectRef, total: statements.length, success, failed, results });
}

async function backfillTwilioReserve(req, res) {
  // Recompute every client's twilio_reserve_cents from their existing
  // credit_ledger history. Idempotent — safe to run anytime. Useful right
  // after migration 0022 to seed the reserve from past purchases/sends.
  const perSeg = parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10);

  const { data: clients, error: clientsErr } = await supabaseAdmin
    .from('clients').select('id');
  if (clientsErr) return res.status(500).json({ error: clientsErr.message });

  let processed = 0, totalReserved = 0, totalUsed = 0;
  for (const c of clients || []) {
    const { data: rows } = await supabaseAdmin
      .from('credit_ledger').select('delta, reason, ref_id, pack, amount_cents, created_at')
      .eq('client_id', c.id).order('created_at', { ascending: true });

    let balance = 0;
    let reserved = 0, used = 0;

    // Wipe prior reserve rows for this client so re-running is a clean rebuild
    await supabaseAdmin.from('twilio_reserves').delete().eq('client_id', c.id);

    for (const r of rows || []) {
      if (r.delta > 0 && (r.reason === 'purchase' || r.reason === 'auto_reload')) {
        const cogs = Math.max(0, r.delta * perSeg);
        balance += cogs; reserved += cogs;
        await supabaseAdmin.from('twilio_reserves').insert({
          client_id: c.id, delta_cents: cogs, reason: 'pack_purchase',
          ref_id: r.ref_id, pack: r.pack, amount_cents: r.amount_cents,
          created_at: r.created_at
        });
      } else if (r.delta < 0 && ['sms_send','sms_blast','welcome_sms','nudge_send','islay_sms'].includes(r.reason)) {
        const segments = -r.delta;
        const cost = segments * perSeg;
        balance -= cost; used += cost;
        await supabaseAdmin.from('twilio_reserves').insert({
          client_id: c.id, delta_cents: -cost, reason: r.reason,
          ref_id: r.ref_id, segments, created_at: r.created_at
        });
      }
    }
    await supabaseAdmin.from('clients')
      .update({ twilio_reserve_cents: balance }).eq('id', c.id);
    processed++; totalReserved += reserved; totalUsed += used;
  }
  return res.status(200).json({
    processed,
    per_segment_cents: perSeg,
    reserved_cents_total: totalReserved,
    used_cents_total: totalUsed,
    balance_cents_total: totalReserved - totalUsed
  });
}

async function setBookingUrl(req, res) {
  const body = await readJson(req);
  const { client_id, booking_url } = body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  let domain = (booking_url || '').trim();
  // Strip protocol + trailing slash so we always store a bare hostname
  domain = domain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}/i.test(domain)) {
    return res.status(400).json({ error: 'Booking URL must be a hostname like book.theflexfacility.com' });
  }

  // Find or create the booking_calendars row for this client
  const { data: existing } = await supabaseAdmin
    .from('booking_calendars').select('id').eq('business_id', client_id).maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin
      .from('booking_calendars').update({ custom_domain: domain || null })
      .eq('id', existing.id);
    if (error) return res.status(400).json({ error: error.message });
  } else if (domain) {
    // Need a slug to satisfy any NOT NULL constraint — derive from domain
    const slug = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const { error } = await supabaseAdmin
      .from('booking_calendars')
      .insert({ business_id: client_id, custom_domain: domain, slug, timezone: 'America/Chicago' });
    if (error) return res.status(400).json({ error: error.message });
  }
  return res.status(200).json({ ok: true, custom_domain: domain || null });
}

async function setStripeKey(req, res) {
  const body = await readJson(req);
  const { client_id, stripe_secret_key } = body || {};
  if (!client_id) return res.status(400).json({ error: 'client_id required' });
  const value = (stripe_secret_key || '').trim() || null;
  if (value && !value.startsWith('sk_')) {
    return res.status(400).json({ error: 'Invalid Stripe key — must start with sk_live_ or sk_test_' });
  }
  const { data, error } = await supabaseAdmin
    .from('clients').update({ stripe_secret_key: value })
    .eq('id', client_id).select('id, name').single();
  if (error) {
    if (/column .*stripe_secret_key.* does not exist/i.test(error.message)) {
      return res.status(400).json({
        error: 'Run migration 0020_client_stripe_key.sql in Supabase SQL editor: ' +
               'ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS stripe_secret_key text;'
      });
    }
    return res.status(400).json({ error: error.message });
  }
  return res.status(200).json({ client: data, key_set: !!value });
}

async function listAdmins(req, res) {
  const { data } = await supabaseAdmin
    .from('platform_admins').select('user_id, email, created_at').order('created_at');
  return res.status(200).json({ admins: data || [] });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');

  // GET-or-POST allowed; per-action validation below.
  if (!methodGuard(req, res, ['GET', 'POST'])) return;

  const ctx = await requireAdmin(req, res); if (!ctx) return;

  try {
    switch (action) {
      case 'list-clients':   return await listClients(req, res);
      case 'client-detail':  return await clientDetail(req, res);
      case 'set-credits':    return await setCredits(req, res, ctx);
      case 'send-as-client': return await sendAsClient(req, res, ctx);
      case 'create-client':  return await createClient(req, res);
      case 'billing-pause':  return await billingPause(req, res);
      case 'set-tier':       return await setTier(req, res);
      case 'set-ga4':        return await setGa4(req, res);
      case 'set-stripe-key': return await setStripeKey(req, res);
      case 'set-booking-url':return await setBookingUrl(req, res);
      case 'backfill-twilio-reserve': return await backfillTwilioReserve(req, res);
      case 'apply-pending-migrations': return await applyPendingMigrations(req, res);
      case 'dedupe-leads':              return await dedupeLeads(req, res);
      case 'ensure-portal-tabs':        return await ensurePortalTabs(req, res);
      case 'trash':                     return await listTrash(req, res, ctx);
      case 'restore-record':            return await restoreTrashRecord(req, res);
      case 'ensure-default-clients': return await ensureDefaultClients(req, res);
      case 'activity-feed':  return await activityFeed(req, res);
      case 'analytics':      return await analytics(req, res);
      case 'list-admins':    return await listAdmins(req, res);
      default:               return res.status(400).json({ error: 'unknown_action' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal_error' });
  }
}
