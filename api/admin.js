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
import { sendMail, passwordResetEmail } from '../lib/mailer.js';

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

// ──────────────────────────────────────────────────────────────
// GoElev8 platform revenue dashboard. Aggregates every source of
// income across the whole fleet of tenants. Admin-only — surfaced
// in the master-admin "Sales" tab. Tolerant of schema gaps (returns
// zeros for any source whose table doesn't exist yet) so this works
// against any project version.
//
// Sources:
//   1. Merch platform fees       (merch_orders.platform_fee_cents)
//   2. Monthly subscriptions     (placeholder: hardcoded WPFF $99/mo
//                                 until we wire Stripe Subscriptions
//                                 list into a separate phase)
//   3. SMS margin                (credit_ledger 'purchase' rows minus
//                                 the per-segment Twilio cost stored
//                                 in TWILIO_COST_PER_SEGMENT_CENTS)
//   4. Booking fees              ($10 per paid booking on WPFF/Flex)
//   5. Hire fees                 ($100 per applications.status='hired'
//                                 for iSlay + Flex)
// ──────────────────────────────────────────────────────────────
const PLATFORM_REVENUE = {
  BOOKING_FEE_CENTS:  1000,   // $10 per paid booking
  HIRE_FEE_CENTS:    10000,   // $100 per hire
  BOOKING_FEE_SLUGS: ['willpower-fitness', 'flex-facility'],
  HIRE_FEE_SLUGS:    ['islay-studios', 'flex-facility'],
  // Hardcoded subscription book. Until Stripe Subscriptions are
  // queried live, this captures the founding link tenants the
  // operator has activated.
  ACTIVE_SUBSCRIPTIONS: [
    { slug: 'willpower-fitness', plan: 'GoElev8 Founding', mrr_cents: 9900 }
  ]
};

// ──────────────────────────────────────────────────────────────
// Migration verifier — probes the live DB for every artifact the
// migration runner is supposed to have installed (tables, columns,
// per-tenant config rows) and returns a pass/fail checklist. The
// admin clicks this AFTER Run Pending Migrations to confirm
// everything actually landed instead of guessing.
// ──────────────────────────────────────────────────────────────
async function verifyMigrations(req, res) {
  const checks = [];
  const ok = (name, detail) => checks.push({ name, ok: true, detail });
  const fail = (name, detail) => checks.push({ name, ok: false, detail });

  // Helper: probe a table by SELECT 1. Returns true if reachable.
  async function tableExists(name) {
    const { error } = await supabaseAdmin.from(name).select('*').limit(1);
    if (!error) return true;
    if (/relation .* does not exist/i.test(error.message)) return false;
    // Some other error — surface but treat as exists (column issue, etc.)
    return true;
  }

  // 1. Merch tables
  for (const t of ['merch_products', 'merch_coupons', 'merch_orders', 'merch_order_items']) {
    if (await tableExists(t)) ok(`Table ${t}`, 'exists');
    else fail(`Table ${t}`, 'missing — Run Pending Migrations to create');
  }

  // 2. Applications tables
  for (const t of ['applications', 'trainer_applications']) {
    if (await tableExists(t)) ok(`Table ${t}`, 'exists');
    else fail(`Table ${t}`, 'missing');
  }

  // 3. Client columns added by recent migrations
  {
    const probes = [
      'portal_api_key', 'platform_fee_pct', 'pass_stripe_fees_to_customer',
      'parent_client_id', 'ga4_property_id', 'ga4_measurement_id', 'portal_tabs'
    ];
    for (const col of probes) {
      const { error } = await supabaseAdmin.from('clients').select(col).limit(1);
      if (!error) ok(`Column clients.${col}`, 'present');
      else if (/column .* does not exist/i.test(error.message)) {
        fail(`Column clients.${col}`, 'missing');
      } else {
        ok(`Column clients.${col}`, 'present (probe surfaced unrelated error: ' + error.message + ')');
      }
    }
  }

  // 4. Storage bucket for merch images
  {
    const { data, error } = await supabaseAdmin
      .from('storage.buckets').select('id, public').eq('id', 'merch-images').maybeSingle();
    if (error || !data) {
      // Fallback: try via storage API list
      try {
        const list = await supabaseAdmin.storage.listBuckets();
        const found = (list?.data || []).find(b => b.id === 'merch-images' || b.name === 'merch-images');
        if (found) ok('Bucket merch-images', `present (public=${found.public})`);
        else fail('Bucket merch-images', 'missing — auto-created on first photo upload, or re-run migrations');
      } catch {
        fail('Bucket merch-images', 'could not verify (storage API unreachable)');
      }
    } else {
      ok('Bucket merch-images', `present (public=${data.public})`);
    }
  }

  // 5. Per-tenant config — Will Power Fitness Factory
  {
    const { data: c } = await supabaseAdmin
      .from('clients').select('slug, name, parent_client_id, portal_api_key, platform_fee_pct, portal_tabs, ga4_property_id')
      .eq('slug', 'willpower-fitness').maybeSingle();
    if (!c) {
      fail('Tenant willpower-fitness', 'row missing');
    } else {
      c.portal_api_key       ? ok('Will Power portal_api_key', 'set')                : fail('Will Power portal_api_key', 'NULL');
      c.platform_fee_pct != null ? ok('Will Power platform_fee_pct', String(c.platform_fee_pct) + '%') : fail('Will Power platform_fee_pct', 'NULL');
      c.parent_client_id     ? ok('Will Power parent_client_id', 'linked to Flex')   : fail('Will Power parent_client_id', 'NOT linked — SMS will fall back to own row');
      c.ga4_property_id      ? ok('Will Power ga4_property_id', c.ga4_property_id)   : fail('Will Power ga4_property_id', 'NULL — Analytics will be empty');
      (Array.isArray(c.portal_tabs) && c.portal_tabs.includes('merch'))
        ? ok('Will Power portal_tabs', 'includes merch')
        : fail('Will Power portal_tabs', `missing 'merch' — current: ${JSON.stringify(c.portal_tabs)}`);
    }
  }

  // 6. Per-tenant config — Flex Facility
  {
    const { data: c } = await supabaseAdmin
      .from('clients').select('slug, portal_api_key, platform_fee_pct, portal_tabs')
      .eq('slug', 'flex-facility').maybeSingle();
    if (!c) {
      fail('Tenant flex-facility', 'row missing');
    } else {
      c.portal_api_key      ? ok('Flex portal_api_key', 'set')                              : fail('Flex portal_api_key', 'NULL');
      c.platform_fee_pct != null ? ok('Flex platform_fee_pct', String(c.platform_fee_pct) + '%') : fail('Flex platform_fee_pct', 'NULL');
      const needed = ['merch', 'trainer_applications'];
      const tabs = Array.isArray(c.portal_tabs) ? c.portal_tabs : [];
      const missing = needed.filter(t => !tabs.includes(t));
      missing.length === 0
        ? ok('Flex portal_tabs', `includes ${needed.join(' + ')}`)
        : fail('Flex portal_tabs', `missing ${missing.join(', ')} — current: ${JSON.stringify(tabs)}`);
    }
  }

  // 7. Per-tenant config — iSlay Studios
  {
    const { data: c } = await supabaseAdmin
      .from('clients').select('slug, portal_api_key, platform_fee_pct, portal_tabs')
      .eq('slug', 'islay-studios').maybeSingle();
    if (!c) {
      fail('Tenant islay-studios', 'row missing');
    } else {
      c.portal_api_key      ? ok('iSlay portal_api_key', 'set')                              : fail('iSlay portal_api_key', 'NULL');
      c.platform_fee_pct != null ? ok('iSlay platform_fee_pct', String(c.platform_fee_pct) + '%') : fail('iSlay platform_fee_pct', 'NULL');
      const tabs = Array.isArray(c.portal_tabs) ? c.portal_tabs : [];
      const needed = ['applications', 'merch'];
      const missing = needed.filter(t => !tabs.includes(t));
      missing.length === 0
        ? ok('iSlay portal_tabs', `includes ${needed.join(' + ')}`)
        : fail('iSlay portal_tabs', `missing ${missing.join(', ')} — current: ${JSON.stringify(tabs)}`);
    }
  }

  // 8. Seeded merch products
  {
    const counts = {};
    for (const slug of ['willpower-fitness', 'flex-facility', 'islay-studios']) {
      const { data: c } = await supabaseAdmin.from('clients').select('id').eq('slug', slug).maybeSingle();
      if (!c) { counts[slug] = 'tenant missing'; continue; }
      const { count } = await supabaseAdmin.from('merch_products').select('id', { count: 'exact', head: true }).eq('client_id', c.id);
      counts[slug] = count ?? 0;
    }
    const total = Object.values(counts).filter(v => typeof v === 'number').reduce((s, n) => s + n, 0);
    total > 0
      ? ok('Seeded merch products', JSON.stringify(counts))
      : fail('Seeded merch products', 'no products in merch_products for any tenant');
  }

  const totalChecks = checks.length;
  const passed = checks.filter(c => c.ok).length;
  const failed = totalChecks - passed;

  return res.status(200).json({
    summary: { total: totalChecks, passed, failed },
    healthy: failed === 0,
    checks
  });
}

async function salesDashboard(req, res) {
  const out = {
    sources: {},
    breakdowns: {},
    totals: { last_30d_cents: 0, lifetime_cents: 0 }
  };

  // Helper: is the error 'relation does not exist'?
  const tableMissing = (err, tbl) =>
    err && new RegExp(`relation .*${tbl}.* does not exist`, 'i').test(err.message);

  const since30d = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

  // ─── 1. Merch platform fees ───────────────────────────────
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('merch_orders')
      .select('client_id, platform_fee_cents, stripe_fee_cents, total_cents, status, created_at');
    if (error && tableMissing(error, 'merch_orders')) {
      out.sources.merch = { last_30d_cents: 0, lifetime_cents: 0, setup_required: true };
    } else if (error) {
      out.sources.merch = { error: error.message };
    } else {
      let life = 0, last30 = 0;
      const perClient = {};
      for (const r of (rows || [])) {
        if (r.status === 'refunded') continue;
        const fee = r.platform_fee_cents || 0;
        life += fee;
        if (r.created_at && r.created_at >= since30d) last30 += fee;
        perClient[r.client_id] = (perClient[r.client_id] || 0) + fee;
      }
      out.sources.merch = { last_30d_cents: last30, lifetime_cents: life };
      out.breakdowns.merch = perClient;
    }
  } catch (e) { out.sources.merch = { error: e.message }; }

  // ─── 2. SMS margin (purchases minus Twilio cost) ─────────
  try {
    const perSegCents = parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10);
    // 'purchase' rows in credit_ledger record what tenants paid for
    // credit packs. The number of credits added equals the segment
    // capacity bought — multiply by Twilio's per-segment cost to get
    // our outbound liability, subtract from revenue for margin.
    const { data: rows, error } = await supabaseAdmin
      .from('credit_ledger')
      .select('client_id, delta, amount_cents, reason, created_at')
      .in('reason', ['purchase', 'auto_reload']);
    if (error && tableMissing(error, 'credit_ledger')) {
      out.sources.sms = { last_30d_cents: 0, lifetime_cents: 0, setup_required: true };
    } else if (error) {
      out.sources.sms = { error: error.message };
    } else {
      let life = 0, last30 = 0;
      const perClient = {};
      for (const r of (rows || [])) {
        const revenue = r.amount_cents || 0;
        const cost    = Math.max(0, (r.delta || 0)) * perSegCents;
        const margin  = revenue - cost;
        life += margin;
        if (r.created_at && r.created_at >= since30d) last30 += margin;
        perClient[r.client_id] = (perClient[r.client_id] || 0) + margin;
      }
      out.sources.sms = { last_30d_cents: last30, lifetime_cents: life, twilio_cost_per_segment_cents: perSegCents };
      out.breakdowns.sms = perClient;
    }
  } catch (e) { out.sources.sms = { error: e.message }; }

  // ─── 3. Subscriptions (hardcoded book, swap to Stripe later) ─
  out.sources.subscriptions = {
    mrr_cents: PLATFORM_REVENUE.ACTIVE_SUBSCRIPTIONS.reduce((s, a) => s + (a.mrr_cents || 0), 0),
    active:    PLATFORM_REVENUE.ACTIVE_SUBSCRIPTIONS,
    note: 'Hardcoded for now. Wire Stripe Subscriptions list in a follow-up to make this live.'
  };

  // ─── 4. Booking fees ($10/paid booking on WPFF + Flex) ───
  try {
    const { data: clients } = await supabaseAdmin
      .from('clients').select('id, slug').in('slug', PLATFORM_REVENUE.BOOKING_FEE_SLUGS);
    const bookingClientIds = (clients || []).map(c => c.id);
    if (bookingClientIds.length) {
      // bookings.status uses mixed case in some seeds — match a
      // permissive set so we don't undercount.
      const { data: rows, error } = await supabaseAdmin
        .from('bookings')
        .select('client_id, status, created_at')
        .in('client_id', bookingClientIds);
      if (error && tableMissing(error, 'bookings')) {
        out.sources.bookings = { last_30d_cents: 0, lifetime_cents: 0, setup_required: true };
      } else if (error) {
        out.sources.bookings = { error: error.message };
      } else {
        const isPaid = (s) => {
          if (!s) return false;
          const x = String(s).toLowerCase();
          return x === 'confirmed' || x === 'paid' || x === 'completed' || x === 'fulfilled';
        };
        let life = 0, last30 = 0;
        const perClient = {};
        for (const r of (rows || [])) {
          if (!isPaid(r.status)) continue;
          life += PLATFORM_REVENUE.BOOKING_FEE_CENTS;
          if (r.created_at && r.created_at >= since30d) last30 += PLATFORM_REVENUE.BOOKING_FEE_CENTS;
          perClient[r.client_id] = (perClient[r.client_id] || 0) + PLATFORM_REVENUE.BOOKING_FEE_CENTS;
        }
        out.sources.bookings = {
          last_30d_cents: last30,
          lifetime_cents: life,
          per_booking_cents: PLATFORM_REVENUE.BOOKING_FEE_CENTS
        };
        out.breakdowns.bookings = perClient;
      }
    } else {
      out.sources.bookings = { last_30d_cents: 0, lifetime_cents: 0 };
    }
  } catch (e) { out.sources.bookings = { error: e.message }; }

  // ─── 5. Hire fees ($100 per applications.status='hired') ──
  try {
    const { data: clients } = await supabaseAdmin
      .from('clients').select('id, slug').in('slug', PLATFORM_REVENUE.HIRE_FEE_SLUGS);
    // applications.client_id is a TEXT slug (not uuid FK) — match
    // all known slug variants for each tenant: hyphen, underscore,
    // and uuid (legacy rows from before the column was cast).
    const slugSet = new Set();
    for (const c of (clients || [])) {
      slugSet.add(c.slug);
      slugSet.add(c.slug.replace(/-/g, '_'));
      slugSet.add(c.id);
    }
    if (!slugSet.size) {
      out.sources.hires = { last_30d_cents: 0, lifetime_cents: 0 };
    } else {
      const { data: rows, error } = await supabaseAdmin
        .from('applications')
        .select('client_id, status, created_at')
        .in('client_id', [...slugSet]);
      if (error && tableMissing(error, 'applications')) {
        out.sources.hires = { last_30d_cents: 0, lifetime_cents: 0, setup_required: true };
      } else if (error) {
        out.sources.hires = { error: error.message };
      } else {
        let life = 0, last30 = 0;
        const perClient = {};
        for (const r of (rows || [])) {
          if (r.status !== 'hired') continue;
          life += PLATFORM_REVENUE.HIRE_FEE_CENTS;
          if (r.created_at && r.created_at >= since30d) last30 += PLATFORM_REVENUE.HIRE_FEE_CENTS;
          // Map back to clients.id so the breakdown is keyed consistently.
          const c = (clients || []).find(c =>
            c.slug === r.client_id ||
            c.slug.replace(/-/g, '_') === r.client_id ||
            c.id === r.client_id
          );
          const key = c?.id || r.client_id;
          perClient[key] = (perClient[key] || 0) + PLATFORM_REVENUE.HIRE_FEE_CENTS;
        }
        out.sources.hires = {
          last_30d_cents: last30,
          lifetime_cents: life,
          per_hire_cents: PLATFORM_REVENUE.HIRE_FEE_CENTS
        };
        out.breakdowns.hires = perClient;
      }
    }
  } catch (e) { out.sources.hires = { error: e.message }; }

  // ─── Totals ───────────────────────────────────────────────
  // Defensive: every accumulator clamps to a finite integer so a
  // single bad row in one source never NaN-poisons the headline KPI.
  for (const src of Object.values(out.sources)) {
    if (!src || typeof src !== 'object') continue;
    const last30 = Number(src.last_30d_cents);
    const life   = Number(src.lifetime_cents);
    if (Number.isFinite(last30)) out.totals.last_30d_cents += last30;
    if (Number.isFinite(life))   out.totals.lifetime_cents += life;
  }
  out.totals.mrr_cents = Number(out.sources.subscriptions?.mrr_cents) || 0;

  // Tenant names for the breakdown UI.
  try {
    const allClientIds = new Set();
    for (const breakdown of Object.values(out.breakdowns)) {
      if (breakdown && typeof breakdown === 'object') {
        for (const k of Object.keys(breakdown)) allClientIds.add(k);
      }
    }
    out.tenants = {};
    if (allClientIds.size) {
      // Only uuid-shaped keys are real client ids; legacy string slug
      // keys (from applications.client_id text values) get filtered
      // here so .in() doesn't fail on a uuid-typed column.
      const ids = [...allClientIds].filter(k =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)
      );
      if (ids.length) {
        const { data: cs } = await supabaseAdmin.from('clients')
          .select('id, slug, name, business_name').in('id', ids);
        for (const c of (cs || [])) {
          out.tenants[c.id] = { slug: c.slug, name: c.business_name || c.name };
        }
      }
    }
  } catch (e) {
    out._tenant_lookup_warning = e.message;
  }

  return res.status(200).json(out);
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
    { slug: 'goelev8',            name: 'GoElev8.ai',                business_name: 'GoElev8.ai' },
    { slug: 'flex-facility',      name: 'The Flex Facility',         business_name: 'The Flex Facility LLC' },
    { slug: 'islay-studios',      name: 'iSlay Studios',             business_name: 'iSlay Studios LLC' },
    { slug: 'ai-exit-strategy',   name: 'The AI Exit Strategy',      business_name: 'The AI Exit Strategy' },
    { slug: 'allthingzblackhair', name: 'AllThingzBlackHair',        business_name: 'AllThingzBlackHair' },
    { slug: 'willpower-fitness',  name: 'Will Power Fitness Factory', business_name: 'Will Power Fitness Factory' }
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

// ──────────────────────────────────────────────────────────────
// Merge duplicate CONTACTS across every tenant.
//
// Triggered when re-uploading a CSV produces the duplicates iSlay
// hit — the import endpoint upserts on (client_id, phone) but
// supabaseAdmin bypasses RLS and the inputs sometimes diverge in
// phone format (raw vs E.164) so the unique constraint can't kick
// in. This action:
//
//   1. Groups contacts per-client by NORMALIZED phone (digits + '+')
//      so '+15551234567', '(555) 123-4567', '5551234567' all collapse
//      into one canonical row.
//   2. Keeps the oldest row in each group, unions tags/source/notes
//      into it, fills any blank name/email/phone from a dupe.
//   3. Repoints every FK reference (messages, bookings, leads,
//      vapi_calls, nudge_queue) from the dupes to the canonical row
//      BEFORE deletion so message history stays intact.
//   4. Deletes the dupes.
//
// Idempotent — re-running finds zero groups once the table is clean.
// Tolerant of tables that don't exist in a given environment
// (catches per-table errors and continues).
// ──────────────────────────────────────────────────────────────
async function dedupeContacts(req, res) {
  const { data: clients } = await supabaseAdmin
    .from('clients').select('id, name, slug');
  let scanned = 0, mergedGroups = 0, deleted = 0;
  const perClient = [];

  const FK_TABLES = ['messages', 'bookings', 'leads', 'vapi_calls', 'nudge_queue'];

  for (const c of clients || []) {
    const { data: contacts, error } = await supabaseAdmin
      .from('contacts').select('id, name, phone, email, tags, source, notes, opted_out, created_at')
      .eq('client_id', c.id)
      .order('created_at', { ascending: true });
    if (error || !contacts?.length) continue;
    scanned += contacts.length;

    // Group by normalized phone. Strip everything except digits + a
    // leading '+'. Empty-phone rows can't dedupe by this key and
    // get skipped (operator can clean those up manually).
    const groups = new Map();
    for (const ct of contacts) {
      const key = String(ct.phone || '').replace(/[^\d+]/g, '');
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ct);
    }
    const allGroups = [...groups.values()].filter(g => g.length > 1);
    let clientMerged = 0, clientDeleted = 0;

    for (const group of allGroups) {
      // Canonical = oldest row (already at index 0 thanks to ORDER BY).
      const canonical = group[0];
      const dupes = group.slice(1);

      // Union tags, prefer first non-null source, concat notes.
      const allTags = new Set();
      for (const ct of group) for (const t of (ct.tags || [])) allTags.add(t);
      const firstSource = group.map(g => g.source).find(Boolean) || null;
      const noteParts = group.map(g => g.notes).filter(Boolean);
      const optedOut = group.some(g => g.opted_out);

      const patch = {};
      if (allTags.size) patch.tags = [...allTags];
      if (firstSource && !canonical.source) patch.source = firstSource;
      if (noteParts.length) {
        const joined = [...new Set(noteParts)].join(' · ');
        patch.notes = joined !== canonical.notes ? joined : canonical.notes;
      }
      if (optedOut !== canonical.opted_out) patch.opted_out = optedOut;
      // Fill blank fields from a dupe if the canonical is missing them.
      for (const f of ['name', 'phone', 'email']) {
        if (!canonical[f]) {
          const filler = dupes.find(d => d[f]);
          if (filler) patch[f] = filler[f];
        }
      }
      if (Object.keys(patch).length) {
        await supabaseAdmin.from('contacts').update(patch).eq('id', canonical.id);
      }

      // Repoint every FK reference from the dupes to canonical.
      for (const dupe of dupes) {
        for (const tbl of FK_TABLES) {
          try {
            await supabaseAdmin.from(tbl)
              .update({ contact_id: canonical.id })
              .eq('contact_id', dupe.id);
          } catch (e) {
            // Table or column missing in this env — keep going.
            if (!/relation .* does not exist|column .* does not exist/i.test(e.message || '')) {
              console.error(`[dedupe-contacts] FK repoint ${tbl}:`, e.message);
            }
          }
        }
      }

      // Delete the dupes.
      const dupeIds = dupes.map(d => d.id);
      const { error: delErr } = await supabaseAdmin
        .from('contacts').delete().in('id', dupeIds);
      if (!delErr) {
        clientMerged++;
        clientDeleted += dupeIds.length;
      } else {
        console.error('[dedupe-contacts] delete failed:', delErr.message);
      }
    }

    if (clientMerged) {
      perClient.push({
        slug: c.slug, name: c.name,
        merged_groups: clientMerged,
        duplicates_removed: clientDeleted
      });
      mergedGroups += clientMerged;
      deleted += clientDeleted;
    }
  }

  return res.status(200).json({
    scanned_contacts: scanned,
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
  // Unified 6-tab nav: messages/blasts/nudges fold under 'messaging',
  // 'contacts' is dropped (Leads is the single CRM view). Overview
  // first, Settings last; the SPA's collapseToCleanNav helper enforces
  // the order client-side too.
  const STANDARD_TABS = [
    'overview', 'leads', 'messaging', 'bookings', 'analytics', 'settings'
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

// Read or set the per-segment Twilio cost (cents) used by both the
// Twilio Reserve trigger and the backfill helper. Stored as a Postgres
// session-scope setting via ALTER DATABASE so the value persists across
// connections and is readable inside the trigger function via
// current_setting('app.twilio_cost_cents').
// One-shot diagnose+repair for the Twilio Reserve setup. Reports what's
// broken (column missing, trigger missing, function missing, no cost
// setting, no reserve rows), then optionally re-applies the migration
// + backfills from ledger history. Returns a structured JSON so the
// operator can see exactly what was wrong.
//
// GET  → diagnose only
// POST → diagnose + repair (re-create function/trigger, set cost if
//        unset, backfill from ledger)
// One-click setup for the GoElev8.ai onboarding payment link. Mirrors
// scripts/setup-onboarding-payment-link.mjs but runs server-side via
// the platform's STRIPE_SECRET_KEY env var so the operator doesn't need
// a local terminal. Idempotent — re-running returns the existing link
// instead of creating a duplicate.
// One-shot server-side onboarding for pending tenants. Mirrors
// scripts/onboard-taes-atbhr.mjs but runs via supabaseAdmin (which
// already uses SUPABASE_SERVICE_ROLE_KEY from Vercel env), so the
// operator doesn't need a local terminal. Idempotent — re-running
// is safe; finds existing auth users instead of creating duplicates.
async function onboardPendingTenants(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const PORTAL_BASE = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
  // TAES + AllThingzBlackHair were onboarded in earlier sessions and the
  // re-runs were idempotent no-ops, so they're retired from this list
  // to keep the button focused on the next pending tenant (Will Power
  // Fitness Factory). If a future re-onboard is needed, re-add them here.
  const TENANTS = [
    {
      slug: 'willpower-fitness',
      business_name: 'Will Power Fitness Factory',
      // GA4 Measurement ID for the booking page tracking tag on
      // book.willpowerfitnessfactory.com (G-XXXXX format used by
      // gtag in the browser).
      ga4_measurement_id: 'G-2EGV382R9C',
      // GA4 numeric Property ID — what the portal uses to query the
      // Data API and pull Will's actual analytics into the Analytics
      // tab. (Different field from the Measurement ID above; both
      // come from the same GA4 property but live in separate columns.)
      ga4_property_id: '536786842',
      // logo1 has a white background — pairs cleanly with the
      // white-container .client-logo CSS so the brand mark sits flat
      // in the sidebar.
      logo_url: `${PORTAL_BASE}/WillPowerFitnessFactory_logo1.jpg`,
      // Will Power inherits Flex Facility's Twilio phone (+18775153539)
      // and credit pool until they get their own. The lib resolver
      // follows parent_client_id at every SMS send / credit read site.
      parent_client_slug: 'flex-facility',
      // Sidebar layout. 'messaging' wraps Inbox/Blasts/Nudges as
      // sub-tabs in the SPA. 'merch' surfaces the Merch storefront
      // (Products / Promos / Orders). 'contacts' is dropped — Leads
      // is the single CRM view. Keep this in sync with the slug-scoped
      // UPDATE in apply-pending-migrations so re-running either the
      // onboard button or Run Pending Migrations converges on the
      // same tab list.
      portal_tabs: ['overview','leads','merch','messaging','bookings','analytics','settings'],
      user: {
        email: 'willpowerfitnessfactory@gmail.com',
        password: 'Will123!!!',
        // Send branded recovery email so Will sets his own password on
        // first login. Template + logo live in Supabase Auth → Email
        // Templates → "Reset Password".
        send_recovery_email: true
      },
      // Mirrors the Flex Facility booking seed but intentionally only
      // one service: a single Free Consultation. Schema follows the
      // post-0018 unification — services key off client_id (not
      // calendar_id) and weekly slots live in availability_templates.
      // The actual booking page lives at book.willpowerfitnessfactory.com
      // (Next.js, separate repo) and hits this portal's
      // /api/portal/bookings/* endpoints for slots + writes.
      booking: {
        slug: 'will-power-fitness-factory',
        custom_domain: 'book.willpowerfitnessfactory.com',
        title: 'Will Power Fitness Factory',
        timezone: 'America/Chicago',
        services: [
          {
            key: 'consultation',
            name: 'Free Consultation',
            full_name: 'Free Fitness Consultation',
            btn_text: 'CONFIRM CONSULTATION — IT\'S FREE',
            max_per_slot: 1,
            info_title: 'CONSULTATION SCHEDULE',
            info_note: 'A 30-minute one-on-one consultation to discuss your fitness goals.',
            sort_order: 1
          }
        ],
        // Mon–Fri 9:00–17:00 in 30-minute slots, attached to the
        // 'consultation' service above. Will can override per-day from
        // the portal Bookings → Availability tab.
        availability: [
          { service_key: 'consultation', dow: 1, start: '09:00', end: '17:00', slot_minutes: 30 },
          { service_key: 'consultation', dow: 2, start: '09:00', end: '17:00', slot_minutes: 30 },
          { service_key: 'consultation', dow: 3, start: '09:00', end: '17:00', slot_minutes: 30 },
          { service_key: 'consultation', dow: 4, start: '09:00', end: '17:00', slot_minutes: 30 },
          { service_key: 'consultation', dow: 5, start: '09:00', end: '17:00', slot_minutes: 30 }
        ]
      }
    }
  ];

  // Probe whether ga4_measurement_id column exists. If migration
  // hasn't been applied, skip that field gracefully.
  let hasMeasurementCol = true;
  {
    const probe = await supabaseAdmin.from('clients').select('ga4_measurement_id').limit(1);
    if (probe.error && /column .*ga4_measurement_id.* does not exist/i.test(probe.error.message)) {
      hasMeasurementCol = false;
    }
  }

  const results = [];

  for (const t of TENANTS) {
    const r = { slug: t.slug, steps: [] };
    try {
      // 1. Find seeded client row.
      // Keep the column list minimal so this query works on every
      // schema version. Anything optional (parent_client_id, ga4_property_id,
      // portal_tabs) is loaded by feature-specific probes below so a
      // missing column never aborts the whole flow.
      const { data: client, error: cErr } = await supabaseAdmin.from('clients')
        .select('id, slug, business_name, ga4_measurement_id, logo_url')
        .eq('slug', t.slug).maybeSingle();
      if (cErr) throw cErr;
      if (!client) {
        r.error = `No clients row for slug="${t.slug}". Did Master Admin auto-seed run? Refresh and try again.`;
        results.push(r);
        continue;
      }
      r.client_id = client.id;
      r.steps.push({ step: 'find_client', ok: true, id: client.id });

      // 1a. Try to read the optional columns — silent fallback when a
      // column doesn't exist yet (e.g. brand-new project that hasn't
      // applied migration 0027).
      let hasParentColumn = false;
      let hasPropertyIdColumn = false;
      let hasPortalTabsColumn = false;
      {
        const probe = await supabaseAdmin
          .from('clients')
          .select('parent_client_id, ga4_property_id, portal_tabs')
          .eq('id', client.id).maybeSingle();
        if (!probe.error && probe.data) {
          client.parent_client_id = probe.data.parent_client_id ?? null;
          client.ga4_property_id  = probe.data.ga4_property_id  ?? null;
          client.portal_tabs      = probe.data.portal_tabs      ?? null;
          hasParentColumn     = true;
          hasPropertyIdColumn = true;
          hasPortalTabsColumn = true;
        } else if (probe.error) {
          // One or more columns missing — narrow down which.
          const m = probe.error.message || '';
          hasParentColumn     = !/column .*parent_client_id.* does not exist/i.test(m);
          hasPropertyIdColumn = !/column .*ga4_property_id.* does not exist/i.test(m);
          hasPortalTabsColumn = !/column .*portal_tabs.* does not exist/i.test(m);
          // Re-probe with whatever subset survives.
          const cols = ['id'];
          if (hasParentColumn)     cols.push('parent_client_id');
          if (hasPropertyIdColumn) cols.push('ga4_property_id');
          if (hasPortalTabsColumn) cols.push('portal_tabs');
          if (cols.length > 1) {
            const r2 = await supabaseAdmin.from('clients')
              .select(cols.join(', ')).eq('id', client.id).maybeSingle();
            if (r2.data) Object.assign(client, r2.data);
          }
        }
      }

      // 1b. Resolve parent client by slug if requested. Tolerant if the
      // parent_client_id column hasn't been migrated yet (0027).
      let parentClientId = null;
      if (t.parent_client_slug) {
        if (!hasParentColumn) {
          r.steps.push({ step: 'resolve_parent', ok: false, skipped: true,
            note: 'parent_client_id column missing — click Run Pending Migrations first.' });
        } else {
          const { data: parent } = await supabaseAdmin
            .from('clients').select('id, slug').eq('slug', t.parent_client_slug).maybeSingle();
          if (parent) {
            parentClientId = parent.id;
            r.steps.push({ step: 'resolve_parent', ok: true, parent_id: parent.id, parent_slug: parent.slug });
          } else {
            r.steps.push({ step: 'resolve_parent', ok: false, error: `parent slug "${t.parent_client_slug}" not found` });
          }
        }
      }

      // 2. Update client row (logo, business_name, GA4 measurement ID,
      // parent linkage, portal_tabs). Tenants can pass null to skip a
      // field — don't blow away existing values with null.
      const patch = {};
      if (t.business_name && client.business_name !== t.business_name) patch.business_name = t.business_name;
      if (t.logo_url      && client.logo_url      !== t.logo_url)      patch.logo_url      = t.logo_url;
      if (hasMeasurementCol && t.ga4_measurement_id && client.ga4_measurement_id !== t.ga4_measurement_id) {
        patch.ga4_measurement_id = t.ga4_measurement_id;
      }
      if (hasPropertyIdColumn && t.ga4_property_id && client.ga4_property_id !== t.ga4_property_id) {
        patch.ga4_property_id = t.ga4_property_id;
      }
      if (hasParentColumn && parentClientId && client.parent_client_id !== parentClientId) {
        patch.parent_client_id = parentClientId;
      }
      if (hasPortalTabsColumn && Array.isArray(t.portal_tabs) && t.portal_tabs.length) {
        // Strict set: overwrite portal_tabs with the configured list so
        // tabs can be REMOVED as well as added (e.g. dropping 'nudges'
        // from Will Power's portal). Operators wanting per-tenant adds
        // beyond the declared set should hit the global
        // 'Sync Tabs to All Tenants' button instead.
        const current = Array.isArray(client.portal_tabs) ? client.portal_tabs : [];
        const sameSet =
          current.length === t.portal_tabs.length &&
          t.portal_tabs.every((x, i) => current[i] === x);
        if (!sameSet) patch.portal_tabs = t.portal_tabs.slice();
      }
      if (Object.keys(patch).length) {
        const { error } = await supabaseAdmin.from('clients').update(patch).eq('id', client.id);
        r.steps.push({ step: 'update_client', ok: !error, fields: Object.keys(patch), error: error?.message });
      } else {
        r.steps.push({ step: 'update_client', ok: true, fields: [], note: 'already current' });
      }

      // 3. Create or find auth user
      let userId = null;
      let userCreated = false;
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: t.user.email, password: t.user.password, email_confirm: true
      });
      if (created?.user?.id) {
        userId = created.user.id;
        userCreated = true;
      } else if (createErr && /already|registered|exists/i.test(createErr.message)) {
        // Find existing user by email and reset their password to the
        // shared value so the credentials always work.
        let page = 1;
        while (page <= 5 && !userId) {
          const { data: list } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
          const u = list?.users?.find(x => x.email === t.user.email);
          if (u) {
            userId = u.id;
            await supabaseAdmin.auth.admin.updateUserById(u.id, { password: t.user.password });
          }
          if (!list?.users?.length || list.users.length < 1000) break;
          page++;
        }
      }
      if (!userId) {
        r.steps.push({ step: 'auth_user', ok: false, error: createErr?.message || 'unknown' });
        results.push(r);
        continue;
      }
      r.steps.push({ step: 'auth_user', ok: true, id: userId, created: userCreated, password_reset: !userCreated });

      // 3b. Optional: send a branded password-recovery email so the new
      // owner can pick their own password instead of using the shared
      // temporary one. We bypass Supabase Auth's built-in mailer because
      // it doesn't expose a BCC field — instead we mint the recovery URL
      // via admin.generateLink and ship it through lib/mailer.js (which
      // bakes in the BCC to the operator on every send).
      if (t.user.send_recovery_email) {
        try {
          const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
            type: 'recovery',
            email: t.user.email,
            options: { redirectTo: `${PORTAL_BASE}/?reset=1` }
          });
          if (linkErr) throw new Error(linkErr.message);
          const recoveryUrl = linkData?.properties?.action_link || linkData?.action_link;
          if (!recoveryUrl) throw new Error('No action_link returned from Supabase');
          const { html, text } = passwordResetEmail({
            recovery_url: recoveryUrl,
            headline: 'Set your GoElev8.ai portal password',
            intro: `Welcome to GoElev8.ai — your portal is ready. Click below to set your password and sign in to start managing ${t.business_name}.`,
            button_label: 'Set your password →'
          });
          await sendMail({
            to: t.user.email,
            subject: 'Set your GoElev8.ai portal password',
            html, text
          });
          r.steps.push({ step: 'recovery_email', ok: true, via: 'resend+bcc' });
        } catch (e) {
          r.steps.push({ step: 'recovery_email', ok: false, error: e.message });
        }
      }

      // 4. Link user → client (role=owner). Manual select-then-insert
      // pattern because client_users in some environments doesn't have
      // a UNIQUE constraint on (user_id, client_id), which makes
      // .upsert(..., { onConflict: '...' }) error out.
      const { data: existingLink } = await supabaseAdmin
        .from('client_users').select('user_id, client_id, role')
        .eq('user_id', userId).eq('client_id', client.id).maybeSingle();
      let linkErr = null;
      if (!existingLink) {
        const { error } = await supabaseAdmin.from('client_users').insert({
          user_id: userId, client_id: client.id, role: 'owner'
        });
        linkErr = error;
      } else if (existingLink.role !== 'owner') {
        const { error } = await supabaseAdmin.from('client_users')
          .update({ role: 'owner' })
          .eq('user_id', userId).eq('client_id', client.id);
        linkErr = error;
      }
      r.steps.push({ step: 'link_user', ok: !linkErr, existed: !!existingLink, error: linkErr?.message });

      // 5. Optional: provision a booking calendar (mirrors the Flex seed
      // in migration 0017 but driven from the tenant config above so each
      // new tenant can ship their own booking page without a migration).
      if (t.booking) {
        const b = t.booking;
        try {
          // 5a. Calendar row — create if missing for this tenant.
          let { data: cal } = await supabaseAdmin.from('booking_calendars')
            .select('id, slug, custom_domain, title')
            .eq('business_id', client.id).maybeSingle();
          if (!cal) {
            const { data: created, error: calErr } = await supabaseAdmin
              .from('booking_calendars').insert({
                business_id: client.id,
                slug: b.slug,
                custom_domain: b.custom_domain || null,
                title: b.title,
                timezone: b.timezone || 'America/Chicago',
                booking_window_days: 30,
                min_notice_hours: 2,
                is_active: true
              }).select('id').single();
            if (calErr) {
              r.steps.push({ step: 'booking_calendar', ok: false, error: calErr.message });
            } else {
              cal = created;
              r.steps.push({ step: 'booking_calendar', ok: true, id: created.id, created: true });
            }
          } else {
            r.steps.push({ step: 'booking_calendar', ok: true, id: cal.id, created: false });
          }

          // 5b. Services + availability_templates — schema per migration
          // 0018: booking_services keys off client_id, availability lives
          // in availability_templates with a service_id FK. UPSERT on the
          // unique (client_id, key) constraint so re-runs don't duplicate.
          if (b.services?.length) {
            const rows = b.services.map(s => ({
              client_id:    client.id,
              key:          s.key,
              name:         s.name,
              full_name:    s.full_name || s.name,
              btn_text:     s.btn_text || null,
              max_per_slot: s.max_per_slot ?? null,
              info_title:   s.info_title || null,
              info_note:    s.info_note || null,
              sort_order:   s.sort_order ?? 0,
              is_active:    true
            }));
            const { error: svcErr } = await supabaseAdmin.from('booking_services')
              .upsert(rows, { onConflict: 'client_id,key' });
            r.steps.push({ step: 'booking_services', ok: !svcErr, count: rows.length, error: svcErr?.message });
          }

          if (b.availability?.length) {
            // Resolve each availability row to its service_id by looking
            // up the service we just upserted on (client_id, key).
            const { data: services } = await supabaseAdmin
              .from('booking_services')
              .select('id, key')
              .eq('client_id', client.id);
            const byKey = Object.fromEntries((services || []).map(s => [s.key, s.id]));
            const rows = b.availability
              .map(a => {
                const sid = byKey[a.service_key];
                if (!sid) return null;
                return {
                  client_id:             client.id,
                  service_id:            sid,
                  day_of_week:           a.dow,
                  start_time:            a.start,
                  end_time:              a.end,
                  slot_duration_minutes: a.slot_minutes ?? 30,
                  is_active:             true
                };
              })
              .filter(Boolean);
            if (rows.length) {
              const { error: avErr } = await supabaseAdmin.from('availability_templates')
                .upsert(rows, { onConflict: 'client_id,service_id,day_of_week,start_time' });
              r.steps.push({ step: 'availability_templates', ok: !avErr, count: rows.length, error: avErr?.message });
            } else {
              r.steps.push({ step: 'availability_templates', ok: false, error: 'no services matched availability rows' });
            }
          }
        } catch (e) {
          r.steps.push({ step: 'booking_setup', ok: false, error: e.message });
        }
      }

      r.email = t.user.email;
    } catch (e) {
      r.error = e.message;
    }
    results.push(r);
  }

  return res.status(200).json({
    has_ga4_measurement_column: hasMeasurementCol,
    results,
    note: hasMeasurementCol ? null : 'ga4_measurement_id column missing — click Run Pending Migrations first to enable that field.'
  });
}

async function createOnboardingPaymentLink(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(400).json({ error: 'STRIPE_SECRET_KEY env var not set in Vercel' });
  }
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  const ONBOARDING_NAME = 'GoElev8.ai Onboarding & Setup';
  const GROWTH_NAME     = 'GoElev8.ai Growth Plan';
  const COUPON_ID       = 'FOUNDING';
  const REDIRECT_URL    = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai')
    .replace(/\/$/, '') + '/?onboarding=done';
  const FLOW_TAG = 'goelev8_onboarding_v1';

  try {
    // Onboarding product — search by exact name first; create if missing.
    let onboardingProduct;
    {
      const list = await stripe.products.search({
        query: `name:'${ONBOARDING_NAME.replace(/'/g, "\\'")}' AND active:'true'`,
        limit: 5
      });
      onboardingProduct = list.data[0] || await stripe.products.create({
        name: ONBOARDING_NAME,
        description: 'One-time onboarding and setup. Founding Client Rate: 50% off via the FOUNDING coupon brings $400 → $200.'
      });
    }

    // Onboarding price — match by amount + currency + non-recurring.
    let onboardingPrice;
    {
      const list = await stripe.prices.list({ product: onboardingProduct.id, active: true, limit: 100 });
      onboardingPrice = list.data.find(p =>
        p.unit_amount === 40000 && p.currency === 'usd' && !p.recurring
      ) || await stripe.prices.create({
        product: onboardingProduct.id,
        unit_amount: 40000, currency: 'usd',
        nickname: 'Onboarding Setup — $400 (regular)'
      });
    }

    // Growth plan product + recurring price.
    let growthProduct;
    {
      const list = await stripe.products.search({
        query: `name:'${GROWTH_NAME.replace(/'/g, "\\'")}' AND active:'true'`,
        limit: 5
      });
      growthProduct = list.data[0] || await stripe.products.create({
        name: GROWTH_NAME,
        description: 'Monthly subscription — full GoElev8.ai automation suite.'
      });
    }
    let growthPrice;
    {
      const list = await stripe.prices.list({ product: growthProduct.id, active: true, limit: 100 });
      growthPrice = list.data.find(p =>
        p.unit_amount === 9900 && p.currency === 'usd' &&
        p.recurring && p.recurring.interval === 'month'
      ) || await stripe.prices.create({
        product: growthProduct.id,
        unit_amount: 9900, currency: 'usd',
        recurring: { interval: 'month' },
        nickname: 'Growth Plan — $99/month'
      });
    }

    // FOUNDING coupon — must be scoped to the onboarding product only
    // so it doesn't accidentally discount the recurring subscription.
    // Stripe coupons can't be patched, so if the existing one is wrong-
    // shaped we delete + recreate.
    let coupon = null;
    try { coupon = await stripe.coupons.retrieve(COUPON_ID); }
    catch (e) { if (e.code !== 'resource_missing') throw e; }
    const correctlyShaped = coupon
      && coupon.percent_off === 50
      && coupon.duration === 'once'
      && coupon.applies_to?.products?.length === 1
      && coupon.applies_to.products[0] === onboardingProduct.id;
    if (!correctlyShaped) {
      if (coupon) await stripe.coupons.del(COUPON_ID);
      coupon = await stripe.coupons.create({
        id: COUPON_ID,
        name: 'Founding Client Rate',
        percent_off: 50,
        duration: 'once',
        applies_to: { products: [onboardingProduct.id] }
      });
    }

    // Promotion code FOUNDING — what the customer types at checkout to
    // apply the coupon. Stripe Payment Links don't accept a `discounts`
    // parameter for auto-application (that's Checkout Sessions only),
    // so we expose the coupon as a typeable code instead. The link
    // also gets allow_promotion_codes:true and a custom_text hint
    // pointing the customer at the code.
    let promotionCode = null;
    {
      const existing = await stripe.promotionCodes.list({
        code: 'FOUNDING', active: true, limit: 1
      });
      promotionCode = existing.data[0] || null;
      if (promotionCode && promotionCode.coupon?.id !== coupon.id) {
        // Code is bound to a different coupon — deactivate and recreate.
        await stripe.promotionCodes.update(promotionCode.id, { active: false });
        promotionCode = null;
      }
    }
    if (!promotionCode) {
      promotionCode = await stripe.promotionCodes.create({
        coupon: coupon.id,
        code: 'FOUNDING',
        metadata: { flow: FLOW_TAG }
      });
    }

    // Look up existing payment link by metadata.flow. Stripe doesn't
    // allow updating subscription_data (or many other fields) on a
    // Payment Link after creation — so if the existing link is missing
    // the 30-day trial, we archive it (active:false) and create a
    // fresh one. That keeps Stripe Dashboard clean and means re-
    // clicking the button propagates schema changes correctly.
    let paymentLink = null;
    {
      const list = await stripe.paymentLinks.list({ active: true, limit: 100 });
      const existing = list.data.find(p => p.metadata?.flow === FLOW_TAG) || null;
      if (existing) {
        const trialDays = existing.subscription_data?.trial_period_days || 0;
        if (trialDays === 30) {
          paymentLink = existing;
        } else {
          // Stale shape — archive it so the next list query won't pick
          // it up, then fall through to create a fresh one below.
          await stripe.paymentLinks.update(existing.id, { active: false });
        }
      }
    }
    if (!paymentLink) {
      paymentLink = await stripe.paymentLinks.create({
        line_items: [
          { price: onboardingPrice.id, quantity: 1 },
          { price: growthPrice.id,     quantity: 1 }
        ],
        allow_promotion_codes: true,
        // 30-day free trial on the recurring plan: customer pays only
        // the $200 setup today (after FOUNDING applied to $400). The
        // $99/month subscription then begins billing 30 days later.
        subscription_data: {
          trial_period_days: 30
        },
        // Custom fields collected at checkout — the Stripe webhook
        // uses these to auto-provision the new tenant's portal
        // (clients row, auth user via invite email, client_users link).
        custom_fields: [
          {
            key: 'business_name',
            label: { type: 'custom', custom: 'Business name' },
            type: 'text',
            text: { minimum_length: 2, maximum_length: 80 }
          },
          {
            key: 'portal_slug',
            label: { type: 'custom', custom: 'Portal slug (e.g. acme-fitness — lowercase, dashes only)' },
            type: 'text',
            text: { minimum_length: 2, maximum_length: 40 }
          }
        ],
        custom_text: {
          submit: {
            message: 'Use code FOUNDING for 50% off the $400 setup. Total today: $200 — your $99/month plan starts after a 30-day free trial. Your portal at portal.goelev8.ai/<slug> goes live the moment payment clears.'
          }
        },
        after_completion: { type: 'redirect', redirect: { url: REDIRECT_URL } },
        metadata: { flow: FLOW_TAG }
      });
    }

    return res.status(200).json({
      ok: true,
      reused: !!paymentLink && paymentLink.created < Math.floor(Date.now() / 1000) - 5,
      payment_link_url: paymentLink.url,
      onboarding: { product: onboardingProduct.id, price: onboardingPrice.id },
      growth:     { product: growthProduct.id,     price: growthPrice.id },
      coupon:     coupon.id,
      mode:       process.env.STRIPE_SECRET_KEY.startsWith('sk_test') ? 'test' : 'live'
    });
  } catch (e) {
    return res.status(400).json({ error: e.message, raw: e.raw?.message });
  }
}

async function twilioReserveDiagnose(req, res) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'SUPABASE_ACCESS_TOKEN not set in Vercel env' });
  let projectRef = null;
  try { projectRef = new URL(process.env.SUPABASE_URL || '').host.split('.')[0]; } catch {}
  if (!projectRef) return res.status(400).json({ error: 'invalid SUPABASE_URL' });
  const sqlUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

  const runSql = async (query) => {
    const r = await fetch(sqlUrl, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const text = await r.text();
    let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { ok: r.ok, status: r.status, data: parsed };
  };

  const checks = {};

  // 1. Column exists?
  const colRes = await runSql(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'twilio_reserve_cents'
  ) AS exists`);
  checks.column_clients_twilio_reserve_cents = colRes.data?.[0]?.exists === true;

  // 2. Reserve ledger table exists?
  const tblRes = await runSql(`SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'twilio_reserves'
  ) AS exists`);
  checks.table_twilio_reserves = tblRes.data?.[0]?.exists === true;

  // 3. Trigger function exists?
  const funcRes = await runSql(`SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'debit_twilio_reserve_on_sms'
  ) AS exists`);
  checks.fn_debit_twilio_reserve_on_sms = funcRes.data?.[0]?.exists === true;

  // 4. Trigger installed?
  const trigRes = await runSql(`SELECT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'credit_ledger_debit_reserve' AND NOT tgisinternal
  ) AS exists`);
  checks.trigger_credit_ledger_debit_reserve = trigRes.data?.[0]?.exists === true;

  // 5. adjust_twilio_reserve RPC exists?
  const rpcRes = await runSql(`SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'adjust_twilio_reserve'
  ) AS exists`);
  checks.fn_adjust_twilio_reserve = rpcRes.data?.[0]?.exists === true;

  // 6. Cost setting
  const costRes = await runSql(`SELECT current_setting('app.twilio_cost_cents', true) AS cents`);
  const costStr = costRes.data?.[0]?.cents;
  checks.cost_setting_cents = costStr ? parseInt(costStr, 10) : null;

  // 7. Counts
  let ledgerEligible = 0, reserveRows = 0, balanceTotal = 0;
  if (checks.column_clients_twilio_reserve_cents) {
    const balRes = await runSql(`SELECT COALESCE(SUM(twilio_reserve_cents), 0)::bigint AS total FROM public.clients`);
    balanceTotal = Number(balRes.data?.[0]?.total || 0);
  }
  if (checks.table_twilio_reserves) {
    const rrRes = await runSql(`SELECT COUNT(*)::int AS n FROM public.twilio_reserves`);
    reserveRows = Number(rrRes.data?.[0]?.n || 0);
  }
  const leRes = await runSql(`SELECT COUNT(*)::int AS n FROM public.credit_ledger
    WHERE delta < 0 AND reason IN ('sms_send','sms_blast','welcome_sms','nudge_send','islay_sms')`);
  ledgerEligible = Number(leRes.data?.[0]?.n || 0);
  checks.eligible_sms_ledger_rows = ledgerEligible;
  checks.twilio_reserves_rows = reserveRows;
  checks.total_reserve_balance_cents = balanceTotal;

  // Repair path (POST)
  let repairs = [];
  if (req.method === 'POST') {
    // Re-create column / table / function / trigger / RPC. Idempotent
    // (uses CREATE OR REPLACE / IF NOT EXISTS).
    const repairStatements = [
      [`ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS twilio_reserve_cents bigint NOT NULL DEFAULT 0;`, 'add column'],
      [`CREATE TABLE IF NOT EXISTS public.twilio_reserves (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
         delta_cents bigint NOT NULL,
         reason text NOT NULL,
         ref_id text, pack text, segments integer, amount_cents integer,
         created_at timestamptz NOT NULL DEFAULT now()
       );`, 'create reserve table'],
      [`CREATE INDEX IF NOT EXISTS twilio_reserves_client_idx ON public.twilio_reserves(client_id, created_at DESC);`, 'create index'],
      [`CREATE OR REPLACE FUNCTION public.debit_twilio_reserve_on_sms()
        RETURNS trigger LANGUAGE plpgsql AS $repair_fn$
        DECLARE v_per_segment_cents int; v_segments int; v_cost int;
        BEGIN
          IF NEW.delta < 0 AND NEW.reason IN ('sms_send','sms_blast','welcome_sms','nudge_send','islay_sms') THEN
            v_segments := -NEW.delta;
            BEGIN
              v_per_segment_cents := COALESCE(NULLIF(current_setting('app.twilio_cost_cents', true), '')::int, 1);
            EXCEPTION WHEN others THEN v_per_segment_cents := 1; END;
            v_cost := v_segments * v_per_segment_cents;
            UPDATE public.clients SET twilio_reserve_cents = COALESCE(twilio_reserve_cents, 0) - v_cost WHERE id = NEW.client_id;
            INSERT INTO public.twilio_reserves (client_id, delta_cents, reason, ref_id, segments)
            VALUES (NEW.client_id, -v_cost, NEW.reason, NEW.ref_id, v_segments);
          END IF;
          RETURN NEW;
        END;
        $repair_fn$;`, 'create debit function'],
      [`DROP TRIGGER IF EXISTS credit_ledger_debit_reserve ON public.credit_ledger;`, 'drop old trigger'],
      [`CREATE TRIGGER credit_ledger_debit_reserve
        AFTER INSERT ON public.credit_ledger
        FOR EACH ROW EXECUTE FUNCTION public.debit_twilio_reserve_on_sms();`, 'create trigger'],
      [`CREATE OR REPLACE FUNCTION public.adjust_twilio_reserve(
         p_client_id uuid, p_delta_cents bigint, p_reason text,
         p_ref_id text DEFAULT NULL, p_pack text DEFAULT NULL,
         p_segments integer DEFAULT NULL, p_amount_cents integer DEFAULT NULL
        ) RETURNS bigint LANGUAGE plpgsql AS $repair_rpc$
        DECLARE v_new_balance bigint;
        BEGIN
          UPDATE public.clients SET twilio_reserve_cents = COALESCE(twilio_reserve_cents, 0) + p_delta_cents
            WHERE id = p_client_id RETURNING twilio_reserve_cents INTO v_new_balance;
          INSERT INTO public.twilio_reserves (client_id, delta_cents, reason, ref_id, pack, segments, amount_cents)
            VALUES (p_client_id, p_delta_cents, p_reason, p_ref_id, p_pack, p_segments, p_amount_cents);
          RETURN v_new_balance;
        END;
        $repair_rpc$;`, 'create adjust rpc']
    ];
    // Initialize cost if missing — use the env fallback, default 1.
    if (checks.cost_setting_cents == null) {
      const envCost = parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10) || 1;
      repairStatements.push([`ALTER DATABASE postgres SET app.twilio_cost_cents = '${envCost}';`, 'set cost setting']);
    }
    for (const [sql, label] of repairStatements) {
      const r = await runSql(sql);
      repairs.push({ step: label, ok: r.ok, error: r.ok ? null : (typeof r.data === 'string' ? r.data.slice(0, 200) : r.data?.message) });
    }

    // Backfill from credit_ledger history so historical purchases /
    // sends are reflected in the reserve balance.
    let backfillResult = null;
    try {
      const r = await fetch(
        `${process.env.PORTAL_BASE_URL || ''}/api/admin?action=backfill-twilio-reserve`,
        { method: 'POST', headers: { 'authorization': req.headers.authorization || '' } }
      );
      backfillResult = await r.json().catch(() => ({}));
    } catch (e) { backfillResult = { error: e.message }; }
    repairs.push({ step: 'backfill from ledger', ok: !backfillResult?.error, result: backfillResult });
  }

  return res.status(200).json({
    project_ref: projectRef,
    checks,
    repairs: req.method === 'POST' ? repairs : undefined,
    diagnosis: (() => {
      if (!checks.column_clients_twilio_reserve_cents) return 'Migration 0022 has not been applied — clients.twilio_reserve_cents is missing. Run repair (POST) or click "Run Pending Migrations".';
      if (!checks.trigger_credit_ledger_debit_reserve)  return 'Trigger missing — SMS sends are not debiting the reserve. Run repair.';
      if (!checks.fn_debit_twilio_reserve_on_sms)       return 'Trigger function missing — run repair.';
      if (checks.cost_setting_cents == null)             return 'Cost setting unset — defaulting to 1¢/segment via fallback. Save a value in the Twilio Reserve panel to persist it in the DB.';
      if (reserveRows === 0 && ledgerEligible > 0)      return 'Setup looks correct but no reserve rows exist yet — click "Rebuild from history" to backfill from credit_ledger.';
      if (balanceTotal === 0 && reserveRows > 0)        return 'Reserve has rows but balance sums to 0 — credits and debits exactly offset (which is unusual). Try Rebuild from history.';
      return 'Looks healthy.';
    })()
  });
}

async function twilioCostSetting(req, res) {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) return res.status(400).json({ error: 'SUPABASE_ACCESS_TOKEN not set in Vercel env' });
  let projectRef = null;
  try { projectRef = new URL(process.env.SUPABASE_URL || '').host.split('.')[0]; } catch {}
  if (!projectRef) return res.status(400).json({ error: 'invalid SUPABASE_URL' });
  const url = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;

  if (req.method === 'GET') {
    // Show current value + the env var fallback the backfill uses.
    let dbVal = null;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: "SELECT current_setting('app.twilio_cost_cents', true) AS cents" })
      });
      const j = await r.json().catch(() => null);
      const row = Array.isArray(j) ? j[0] : (j?.[0] || null);
      dbVal = row?.cents ? parseInt(row.cents, 10) : null;
    } catch {}
    return res.status(200).json({
      db_setting_cents: dbVal,
      env_fallback_cents: parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10),
      effective_cents: dbVal != null ? dbVal : parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10)
    });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const cents = parseInt(body?.cents, 10);
    if (!Number.isFinite(cents) || cents < 0 || cents > 100) {
      return res.status(400).json({ error: 'cents must be an integer between 0 and 100' });
    }
    // ALTER DATABASE persists the setting across reconnects; the trigger
    // reads it via current_setting('app.twilio_cost_cents', true).
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: `ALTER DATABASE postgres SET app.twilio_cost_cents = '${cents}';` })
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(400).json({ error: 'failed to set: ' + txt.slice(0, 200) });
    }
    return res.status(200).json({ ok: true, db_setting_cents: cents });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
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
           v_per_segment_cents := COALESCE(NULLIF(current_setting('app.twilio_cost_cents', true), '')::int, 1);
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
    // Coerce tags columns to text[] before indexing — older
    // environments may have it as a single text column from a partial
    // migration run, which can't take a GIN index. Idempotent: only
    // ALTERs when the data_type is currently 'text'. Existing values
    // are converted: NULL/empty → {}, '{a,b}' literal → array, plain
    // 'a,b' string → split on commas.
    `DO $migrate$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='leads'
            AND column_name='tags' AND data_type='text'
       ) THEN
         ALTER TABLE public.leads ALTER COLUMN tags DROP DEFAULT;
         ALTER TABLE public.leads ALTER COLUMN tags TYPE text[]
           USING (CASE
             WHEN tags IS NULL OR tags = '' THEN ARRAY[]::text[]
             WHEN tags LIKE '{%}' THEN tags::text[]
             ELSE string_to_array(tags, ',')
           END);
         ALTER TABLE public.leads ALTER COLUMN tags SET DEFAULT '{}'::text[];
       END IF;
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='contacts'
            AND column_name='tags' AND data_type='text'
       ) THEN
         ALTER TABLE public.contacts ALTER COLUMN tags DROP DEFAULT;
         ALTER TABLE public.contacts ALTER COLUMN tags TYPE text[]
           USING (CASE
             WHEN tags IS NULL OR tags = '' THEN ARRAY[]::text[]
             WHEN tags LIKE '{%}' THEN tags::text[]
             ELSE string_to_array(tags, ',')
           END);
         ALTER TABLE public.contacts ALTER COLUMN tags SET DEFAULT '{}'::text[];
       END IF;
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='bookings'
            AND column_name='tags' AND data_type='text'
       ) THEN
         ALTER TABLE public.bookings ALTER COLUMN tags DROP DEFAULT;
         ALTER TABLE public.bookings ALTER COLUMN tags TYPE text[]
           USING (CASE
             WHEN tags IS NULL OR tags = '' THEN ARRAY[]::text[]
             WHEN tags LIKE '{%}' THEN tags::text[]
             ELSE string_to_array(tags, ',')
           END);
         ALTER TABLE public.bookings ALTER COLUMN tags SET DEFAULT '{}'::text[];
       END IF;
     END
     $migrate$;`,
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

    // ----- 0027: GA4 Measurement ID (gtag.js G-XXXX) per tenant. Distinct
    //       from ga4_property_id, which is the numeric Property ID used
    //       by the Data API. The Measurement ID is for client-side gtag
    //       embedding on the tenant's site. -----
    `ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS ga4_measurement_id text;`,

    // ----- 0028: ensure client_users has a UNIQUE constraint on
    //       (user_id, client_id) so upserts can use ON CONFLICT. Some
    //       environments seeded this table without the constraint,
    //       which broke the onboarding-tenants admin action.
    `DO $migrate$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename  = 'client_users'
            AND indexname  = 'client_users_user_client_uniq'
       ) AND NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name   = 'client_users'
            AND constraint_type IN ('UNIQUE','PRIMARY KEY')
            AND constraint_name LIKE '%user_id%client_id%'
       ) THEN
         BEGIN
           ALTER TABLE public.client_users
             ADD CONSTRAINT client_users_user_client_uniq UNIQUE (user_id, client_id);
         EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
         END;
       END IF;
     END
     $migrate$;`,

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
       FOR EACH ROW EXECUTE FUNCTION public.cancel_nudges_on_booking();`,

    // ----- 0027: parent_client_id for shared Twilio + credit pools -----
    // Will Power Fitness Factory points at The Flex Facility so both
    // tenants share Flex's phone number and SMS credit pool while
    // keeping independent leads/contacts/bookings/messages.
    `ALTER TABLE public.clients
       ADD COLUMN IF NOT EXISTS parent_client_id uuid
         REFERENCES public.clients(id) ON DELETE SET NULL;`,
    `CREATE INDEX IF NOT EXISTS clients_parent_client_idx
       ON public.clients(parent_client_id)
       WHERE parent_client_id IS NOT NULL;`,
    `CREATE OR REPLACE FUNCTION public.check_parent_client_no_chain()
     RETURNS trigger LANGUAGE plpgsql AS $func$
     DECLARE
       v_parent_of_parent uuid;
     BEGIN
       IF NEW.parent_client_id IS NULL THEN RETURN NEW; END IF;
       IF NEW.parent_client_id = NEW.id THEN
         RAISE EXCEPTION 'A client cannot be its own parent';
       END IF;
       SELECT parent_client_id INTO v_parent_of_parent
         FROM public.clients WHERE id = NEW.parent_client_id;
       IF v_parent_of_parent IS NOT NULL THEN
         RAISE EXCEPTION 'parent_client_id must point at a top-level client (no chains)';
       END IF;
       RETURN NEW;
     END;
     $func$;`,
    `DROP TRIGGER IF EXISTS clients_parent_no_chain ON public.clients;`,
    `CREATE TRIGGER clients_parent_no_chain
       BEFORE INSERT OR UPDATE OF parent_client_id ON public.clients
       FOR EACH ROW EXECUTE FUNCTION public.check_parent_client_no_chain();`,

    // ----- One-shot data fix: rewrite portal_tabs for all tenants -----
    // Every tenant gets the unified 6-tab nav (overview, leads,
    // messaging, bookings, analytics, settings). The SPA's
    // collapseToCleanNav helper handles tenants whose row hasn't been
    // updated yet, but applying it at the DB level keeps /api/portal/me
    // responses honest. portal_tabs is jsonb so the value is a JSON
    // literal. Idempotent.
    `UPDATE public.clients
       SET portal_tabs = '["overview","leads","messaging","bookings","analytics","settings"]'::jsonb
     WHERE portal_tabs IS DISTINCT FROM
           '["overview","leads","messaging","bookings","analytics","settings"]'::jsonb;`,

    // ----- One-shot data fix: GA4 Property IDs -----
    // Wires each tenant's numeric Property ID so the Analytics tab can
    // query the GA4 Data API. Slug-scoped UPDATEs — idempotent.
    `UPDATE public.clients SET ga4_property_id = '536338826'
       WHERE slug = 'ai-exit-strategy'
         AND ga4_property_id IS DISTINCT FROM '536338826';`,
    `UPDATE public.clients SET ga4_property_id = '536419721'
       WHERE slug = 'allthingzblackhair'
         AND ga4_property_id IS DISTINCT FROM '536419721';`,

    // ----- Applications feature (additive) -----
    // Creates public.applications + RLS for the public submit-application
    // Edge Function and the portal Applications tab. Receives artist
    // applications from each tenant's marketing site keyed on a text
    // client_id slug (e.g. 'islay_studios'). Idempotent.
    //
    // Defensive ALTER: an earlier installation of this table existed in
    // some projects with client_id typed as uuid (and an FK to
    // public.clients(id)), which is the wrong type — the portal queries
    // with slug-like text values ('islay_studios' etc.). Drop any
    // pre-existing FK on client_id, then cast the column to text in
    // place; existing rows are preserved as their string form. Skipped
    // silently when the column is already text.
    `DO $migrate$
     DECLARE
       v_constraint text;
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'applications'
            AND column_name  = 'client_id'
            AND data_type    = 'uuid'
       ) THEN
         -- Drop ANY foreign key constraint on the client_id column
         -- (the autogenerated name is usually applications_client_id_fkey
         -- but we look it up to be robust against renames).
         FOR v_constraint IN
           SELECT tc.constraint_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema    = kcu.table_schema
            WHERE tc.table_schema   = 'public'
              AND tc.table_name     = 'applications'
              AND tc.constraint_type= 'FOREIGN KEY'
              AND kcu.column_name   = 'client_id'
         LOOP
           EXECUTE format('ALTER TABLE public.applications DROP CONSTRAINT %I', v_constraint);
         END LOOP;
         ALTER TABLE public.applications
           ALTER COLUMN client_id TYPE text USING client_id::text;
       END IF;
     END
     $migrate$;`,
    `CREATE TABLE IF NOT EXISTS public.applications (
       id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
       client_id text NOT NULL,
       created_at timestamptz DEFAULT now() NOT NULL,
       status text DEFAULT 'new' NOT NULL,
       full_name text,
       phone text,
       email text,
       instagram text,
       city_state text,
       specialty text[],
       years_experience text,
       employment_status text,
       has_clientele boolean,
       clientele_count text,
       bio text,
       portfolio_url text,
       desired_start date,
       booth_preference text,
       schedule text,
       referral_source text,
       notes text
     );`,
    `CREATE INDEX IF NOT EXISTS applications_client_created_idx
       ON public.applications(client_id, created_at DESC);`,
    `CREATE INDEX IF NOT EXISTS applications_client_status_idx
       ON public.applications(client_id, status);`,
    `ALTER TABLE public.applications ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "allow_anon_insert" ON public.applications;`,
    `CREATE POLICY "allow_anon_insert" ON public.applications
       FOR INSERT TO anon WITH CHECK (true);`,
    `DROP POLICY IF EXISTS "allow_auth_read" ON public.applications;`,
    `CREATE POLICY "allow_auth_read" ON public.applications
       FOR SELECT TO authenticated USING (true);`,
    `DROP POLICY IF EXISTS "allow_auth_update" ON public.applications;`,
    `CREATE POLICY "allow_auth_update" ON public.applications
       FOR UPDATE TO authenticated USING (true);`,

    // iSlay Studios gets Applications in place of Bookings — they
    // don't surface a booking sidebar tab, just the applications
    // pipeline. Slug-scoped UPDATE runs AFTER the all-tenants
    // standardize so iSlay ends up with this exact 6-tab variant.
    // Idempotent.
    `UPDATE public.clients
       SET portal_tabs = '["overview","leads","applications","messaging","analytics","settings"]'::jsonb
     WHERE slug = 'islay-studios'
       AND portal_tabs IS DISTINCT FROM
           '["overview","leads","applications","messaging","analytics","settings"]'::jsonb;`,

    // ----- Merch feature (additive) -----
    // clients.portal_api_key + merch_products / merch_coupons /
    // merch_orders / merch_order_items. Powers the storefront on
    // each tenant's marketing site and the portal Merch tab.
    `ALTER TABLE public.clients
       ADD COLUMN IF NOT EXISTS portal_api_key text;`,
    `CREATE UNIQUE INDEX IF NOT EXISTS clients_portal_api_key_uniq
       ON public.clients(portal_api_key)
       WHERE portal_api_key IS NOT NULL;`,
    `CREATE TABLE IF NOT EXISTS public.merch_products (
       id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       client_id                uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
       product_key              text NOT NULL,
       name                     text NOT NULL,
       description              text,
       base_price_cents         integer NOT NULL DEFAULT 0 CHECK (base_price_cents >= 0),
       compare_at_price_cents   integer CHECK (compare_at_price_cents IS NULL OR compare_at_price_cents >= 0),
       image_url                text,
       printify_product_id      text,
       is_active                boolean NOT NULL DEFAULT true,
       sort_order               integer NOT NULL DEFAULT 0,
       created_at               timestamptz NOT NULL DEFAULT now(),
       updated_at               timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT merch_products_client_key_uniq UNIQUE (client_id, product_key)
     );`,
    `CREATE INDEX IF NOT EXISTS merch_products_client_sort_idx
       ON public.merch_products(client_id, sort_order);`,
    `CREATE TABLE IF NOT EXISTS public.merch_coupons (
       id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       client_id           uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
       code                text NOT NULL,
       name                text,
       discount_type       text NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
       discount_value      integer NOT NULL CHECK (discount_value > 0),
       min_subtotal_cents  integer CHECK (min_subtotal_cents IS NULL OR min_subtotal_cents >= 0),
       expires_at          timestamptz,
       max_uses            integer CHECK (max_uses IS NULL OR max_uses > 0),
       used_count          integer NOT NULL DEFAULT 0,
       is_active           boolean NOT NULL DEFAULT true,
       created_at          timestamptz NOT NULL DEFAULT now(),
       updated_at          timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT merch_coupons_client_code_uniq UNIQUE (client_id, code)
     );`,
    `CREATE INDEX IF NOT EXISTS merch_coupons_client_active_idx
       ON public.merch_coupons(client_id, is_active);`,
    `CREATE TABLE IF NOT EXISTS public.merch_orders (
       id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       client_id                uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
       customer_name            text,
       customer_email           text,
       customer_phone           text,
       shipping_address1        text,
       shipping_address2        text,
       shipping_city            text,
       shipping_state           text,
       shipping_zip             text,
       shipping_country         text,
       subtotal_cents           integer NOT NULL DEFAULT 0,
       shipping_cents           integer NOT NULL DEFAULT 0,
       discount_cents           integer NOT NULL DEFAULT 0,
       total_cents              integer NOT NULL DEFAULT 0,
       coupon_code              text,
       stripe_payment_id        text NOT NULL,
       printify_order_id        text,
       external_order_number    text,
       status                   text NOT NULL DEFAULT 'paid'
         CHECK (status IN ('paid', 'fulfilled', 'shipped', 'refunded')),
       created_at               timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT merch_orders_stripe_payment_uniq UNIQUE (stripe_payment_id)
     );`,
    `CREATE INDEX IF NOT EXISTS merch_orders_client_created_idx
       ON public.merch_orders(client_id, created_at DESC);`,
    `CREATE TABLE IF NOT EXISTS public.merch_order_items (
       id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       order_id      uuid NOT NULL REFERENCES public.merch_orders(id) ON DELETE CASCADE,
       product_key   text,
       name          text,
       color         text,
       size          text,
       quantity      integer NOT NULL DEFAULT 1,
       price_cents   integer NOT NULL DEFAULT 0
     );`,
    `CREATE INDEX IF NOT EXISTS merch_order_items_order_idx
       ON public.merch_order_items(order_id);`,
    `ALTER TABLE public.merch_products    ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE public.merch_coupons     ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE public.merch_orders      ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE public.merch_order_items ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS merch_products_tenant_all ON public.merch_products;`,
    `CREATE POLICY merch_products_tenant_all ON public.merch_products
       FOR ALL USING (client_id = public.current_client_id())
       WITH CHECK (client_id = public.current_client_id());`,
    `DROP POLICY IF EXISTS merch_coupons_tenant_all ON public.merch_coupons;`,
    `CREATE POLICY merch_coupons_tenant_all ON public.merch_coupons
       FOR ALL USING (client_id = public.current_client_id())
       WITH CHECK (client_id = public.current_client_id());`,
    `DROP POLICY IF EXISTS merch_orders_tenant_all ON public.merch_orders;`,
    `CREATE POLICY merch_orders_tenant_all ON public.merch_orders
       FOR ALL USING (client_id = public.current_client_id())
       WITH CHECK (client_id = public.current_client_id());`,
    `DROP POLICY IF EXISTS merch_order_items_tenant_select ON public.merch_order_items;`,
    `CREATE POLICY merch_order_items_tenant_select ON public.merch_order_items
       FOR SELECT USING (order_id IN (
         SELECT id FROM public.merch_orders WHERE client_id = public.current_client_id()
       ));`,
    `DROP TRIGGER IF EXISTS merch_products_touch ON public.merch_products;`,
    `CREATE TRIGGER merch_products_touch BEFORE UPDATE ON public.merch_products
       FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();`,
    `DROP TRIGGER IF EXISTS merch_coupons_touch ON public.merch_coupons;`,
    `CREATE TRIGGER merch_coupons_touch BEFORE UPDATE ON public.merch_coupons
       FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();`,

    // ----- Platform fee config + per-order fee breakdown -----
    // Adds a per-tenant platform fee rate (% of subtotal) that the
    // storefront includes in the customer-facing total via
    // /api/external/fees/quote, and records on each order so the
    // operator and platform can both audit what was collected.
    //
    // Money flow (with Stripe Connect): platform_fee_cents becomes
    // the application_fee_amount on the PaymentIntent — Stripe routes
    // tenant_takehome to the connected account and platform_fee to
    // the platform account at charge time.
    //
    // Money flow (without Connect, near-term): all money lands in
    // tenant's Stripe account; portal records what's owed for
    // monthly invoicing.
    `ALTER TABLE public.clients
       ADD COLUMN IF NOT EXISTS platform_fee_pct numeric(5,2)
         CHECK (platform_fee_pct IS NULL OR (platform_fee_pct >= 0 AND platform_fee_pct <= 100));`,
    `ALTER TABLE public.clients
       ADD COLUMN IF NOT EXISTS pass_stripe_fees_to_customer boolean DEFAULT true;`,
    `ALTER TABLE public.merch_orders
       ADD COLUMN IF NOT EXISTS platform_fee_cents integer NOT NULL DEFAULT 0;`,
    `ALTER TABLE public.merch_orders
       ADD COLUMN IF NOT EXISTS stripe_fee_cents integer NOT NULL DEFAULT 0;`,

    // Default Will Power to the platform default rate (10%). NULL on
    // other rows just means 'use PLATFORM_FEE_DEFAULT_PCT env'.
    `UPDATE public.clients
       SET platform_fee_pct = 10
     WHERE slug = 'willpower-fitness'
       AND platform_fee_pct IS NULL;`,

    // Generate a portal_api_key for Will Power so his storefront can
    // authenticate to /api/external/orders. Slug-scoped, idempotent
    // (skipped when one already exists). Uses gen_random_uuid() as
    // the secret value — high entropy, URL-safe enough.
    `UPDATE public.clients
       SET portal_api_key = 'wpff_' || replace(gen_random_uuid()::text, '-', '')
     WHERE slug = 'willpower-fitness'
       AND portal_api_key IS NULL;`,
    `UPDATE public.clients
       SET portal_api_key = 'flex_' || replace(gen_random_uuid()::text, '-', '')
     WHERE slug = 'flex-facility'
       AND portal_api_key IS NULL;`,

    // Platform fee for Flex Facility — 7%, matching the rate their
    // existing storefront's lib/platform-config.js has been billing
    // at. (Will Power stays on 10%, the platform default.)
    // IS DISTINCT FROM gate so re-runs of this UPDATE either
    // initialize a NULL row or correct a stale 10% from earlier runs.
    `UPDATE public.clients
       SET platform_fee_pct = 7
     WHERE slug = 'flex-facility'
       AND platform_fee_pct IS DISTINCT FROM 7;`,

    // Will Power gets Merch in his sidebar. Slot ordering applied
    // client-side by collapseToCleanNav; here we just write the array.
    // Idempotent.
    `UPDATE public.clients
       SET portal_tabs = '["overview","leads","merch","messaging","bookings","analytics","settings"]'::jsonb
     WHERE slug = 'willpower-fitness'
       AND portal_tabs IS DISTINCT FROM
           '["overview","leads","merch","messaging","bookings","analytics","settings"]'::jsonb;`,

    // Flex Facility gets Merch in the same slot. They keep their
    // Bookings tab since the booking calendar is core to their
    // business — Merch sits alongside, not in place of it.
    `UPDATE public.clients
       SET portal_tabs = '["overview","leads","trainer_applications","merch","messaging","bookings","analytics","settings"]'::jsonb
     WHERE slug = 'flex-facility'
       AND portal_tabs IS DISTINCT FROM
           '["overview","leads","trainer_applications","merch","messaging","bookings","analytics","settings"]'::jsonb;`,

    // iSlay Studios — Nate gets Merch alongside Applications. Order:
    // Overview, Leads, Applications, Merch, Messaging, Analytics,
    // Settings (still no Bookings tab per the iSlay layout decided
    // earlier — Applications is their primary intake pipeline).
    `UPDATE public.clients
       SET portal_tabs = '["overview","leads","applications","merch","messaging","analytics","settings"]'::jsonb
     WHERE slug = 'islay-studios'
       AND portal_tabs IS DISTINCT FROM
           '["overview","leads","applications","merch","messaging","analytics","settings"]'::jsonb;`,

    // iSlay portal_api_key + 10% platform fee. Same default rate as
    // Will Power; can be tuned per-tenant later via Master Admin.
    `UPDATE public.clients
       SET portal_api_key = 'islay_' || replace(gen_random_uuid()::text, '-', '')
     WHERE slug = 'islay-studios'
       AND portal_api_key IS NULL;`,
    `UPDATE public.clients
       SET platform_fee_pct = 10
     WHERE slug = 'islay-studios'
       AND platform_fee_pct IS NULL;`,

    // ----- Supabase Storage bucket for uploaded product photos -----
    // Public bucket so the storefront can fetch images via the URL
    // we store on merch_products.image_url. Service-role uploads
    // come through /api/portal/merch?action=upload-image; no anon
    // write policy needed.
    `INSERT INTO storage.buckets (id, name, public)
     VALUES ('merch-images', 'merch-images', true)
     ON CONFLICT (id) DO UPDATE SET public = true;`,

    // ----- Seed merch_products with what's currently on the live
    //       storefronts so operators don't start from an empty list.
    //       Each row is slug-scoped and ON CONFLICT (client_id,
    //       product_key) DO NOTHING — running this a second time
    //       won't overwrite changes the operator made via the portal.
    // -----------------------------------------------------------
    // Will Power Fitness Factory — 4 products from merch/index.html
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'tee', 'WillPower Classic Tee', 'Premium heavyweight tee. Built for the grind.', 3499,
            'https://willpowerfitnessfactory.com/white-tee.png', true, 1
       FROM public.clients WHERE slug = 'willpower-fitness'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'tank', 'WillPower Tank', 'Cut for movement. Train in style.', 2799,
            'https://willpowerfitnessfactory.com/image1.png', true, 2
       FROM public.clients WHERE slug = 'willpower-fitness'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'hoodie', 'WillPower Hoodie', 'Heavyweight pullover. Represent everywhere.', 5999,
            NULL, false, 3
       FROM public.clients WHERE slug = 'willpower-fitness'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'snapback', 'Fitness Factory Snapback', 'Structured snapback. One size fits all.', 2999,
            NULL, false, 4
       FROM public.clients WHERE slug = 'willpower-fitness'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,

    // The Flex Facility hoodie — one product key per color so Kenny
    // can price + image each variant independently from the portal
    // Merch tab. The ebook is tracked separately via the existing
    // R2S sales pipeline, not seeded here.
    //
    // Backfill: rename the legacy 'hoodie' row (originally seeded as
    // the Black/Cyan variant) so the rename + add path is idempotent
    // and doesn't strand price edits the operator made on the old
    // row. Done BEFORE the new INSERTs so the UPDATE never collides.
    `UPDATE public.merch_products
       SET product_key = 'hoodie-black-cyan',
           name = CASE WHEN name LIKE '%Black/Cyan%' THEN name
                       ELSE 'Flex Training Sleeveless Hoodie — Black/Cyan' END,
           image_url = COALESCE(image_url, 'https://theflexfacility.com/assets/merch/hoodie-black-cyan.png')
     WHERE client_id = (SELECT id FROM public.clients WHERE slug = 'flex-facility')
       AND product_key = 'hoodie';`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'hoodie-black-cyan', 'Flex Training Sleeveless Hoodie — Black/Cyan', NULL, 4500,
            'https://theflexfacility.com/assets/merch/hoodie-black-cyan.png', true, 1
       FROM public.clients WHERE slug = 'flex-facility'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'hoodie-black-white', 'Flex Training Sleeveless Hoodie — Black/White', NULL, 4500,
            'https://theflexfacility.com/assets/merch/hoodie-black-white.png', true, 2
       FROM public.clients WHERE slug = 'flex-facility'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'hoodie-white', 'Flex Training Sleeveless Hoodie — White', NULL, 4500,
            'https://theflexfacility.com/assets/merch/hoodie-white.png', true, 3
       FROM public.clients WHERE slug = 'flex-facility'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,

    // ----- Opt-out propagation: leads.opted_out + 'Do Not Contact' -----
    // Twilio's inbound STOP handler marked contacts.opted_out but the
    // matching lead row stayed un-flagged, so lead-based blast
    // segments (Funnel Leads, First Timers, etc.) still hit those
    // people. Adds the column + backfills from contacts so any
    // pre-existing opt-out propagates immediately.
    `ALTER TABLE public.leads
       ADD COLUMN IF NOT EXISTS opted_out boolean NOT NULL DEFAULT false;`,
    `CREATE INDEX IF NOT EXISTS leads_opted_out_idx
       ON public.leads(client_id, opted_out)
       WHERE opted_out = true;`,
    // Backfill: every lead whose phone matches an opted-out contact
    // gets opted_out = true + the 'Do Not Contact' tag (the same tag
    // the nudges blocklist already honors). Tolerant of legacy rows
    // missing tags column.
    `DO $migrate$
     BEGIN
       UPDATE public.leads l
          SET opted_out = true,
              tags = (
                SELECT ARRAY(
                  SELECT DISTINCT unnest(COALESCE(l.tags, ARRAY[]::text[]) || ARRAY['Do Not Contact'])
                )
              )
        WHERE l.opted_out = false
          AND EXISTS (
            SELECT 1 FROM public.contacts c
             WHERE c.client_id = l.client_id
               AND c.phone     = l.phone
               AND c.opted_out = true
          );
       -- Mirror back to contacts: any contact whose lead is already
       -- opted-out should also carry the contact-side flag.
       UPDATE public.contacts c
          SET opted_out = true,
              tags = (
                SELECT ARRAY(
                  SELECT DISTINCT unnest(COALESCE(c.tags, ARRAY[]::text[]) || ARRAY['Do Not Contact'])
                )
              )
        WHERE c.opted_out = false
          AND EXISTS (
            SELECT 1 FROM public.leads l
             WHERE l.client_id = c.client_id
               AND l.phone     = c.phone
               AND l.opted_out = true
          );
     END
     $migrate$;`,

    // ----- Enforce per-tenant contact uniqueness on phone -----
    // Prevents the 'CSV re-upload created duplicate contacts' problem
    // iSlay hit. supabaseAdmin (service-role) bypasses RLS, and the
    // application-level onConflict only catches matches when the
    // phone strings are literally identical — but historical rows
    // had raw '(555) 123-4567' alongside re-imports as '+15551234567',
    // so the application couldn't dedupe them on its own. Adding a
    // proper unique constraint forces the DB itself to enforce it.
    //
    // Idempotent: skipped if a unique index already exists on
    // (client_id, phone). Existing duplicates would prevent the
    // CREATE — operators should click 'Merge Duplicate Contacts'
    // first if the runner returns 'unique constraint violated'.
    `DO $migrate$
     BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'contacts'
            AND indexname = 'contacts_client_phone_uniq'
       ) THEN
         BEGIN
           CREATE UNIQUE INDEX contacts_client_phone_uniq
             ON public.contacts(client_id, phone)
             WHERE phone IS NOT NULL;
         EXCEPTION WHEN unique_violation OR not_null_violation OR others THEN
           -- Existing duplicates block the index. Operator runs the
           -- 'Merge Duplicate Contacts' action then re-runs migrations.
           RAISE NOTICE 'contacts_client_phone_uniq deferred — merge dupes first.';
         END;
       END IF;
     END
     $migrate$;`,

    // Backfill the 'Imported' tag onto every contact whose source
    // column already says they came from a CSV import. New imports
    // get the tag added automatically by the import endpoint; this
    // catches the historical rows so the SMS Blasts 'Imported
    // Contacts Only' segment + the tag-filter chips cover them too.
    // Idempotent — the NOT-IN-tags guard prevents double-tagging.
    `DO $migrate$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'contacts'
            AND column_name  = 'source'
       ) AND EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name   = 'contacts'
            AND column_name  = 'tags'
       ) THEN
         UPDATE public.contacts
            SET tags = (
              SELECT ARRAY(
                SELECT DISTINCT unnest(COALESCE(tags, ARRAY[]::text[]) || ARRAY['Imported'])
              )
            )
          WHERE source = 'import'
            AND NOT (COALESCE(tags, ARRAY[]::text[]) && ARRAY['Imported']);
       END IF;
     END
     $migrate$;`,

    // iSlay Studios — 3 hair-care products for the upcoming
    // islaystudiosllc.com/shop page. Nate uploads real photos via
    // the portal Merch tab (image_url starts NULL). Default price
    // $19.99 across all three; he can edit per-SKU.
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'shampoo', 'iSlay Studios Shampoo',
            'Salon-grade shampoo formulated for daily use.',
            1999, NULL, true, 1
       FROM public.clients WHERE slug = 'islay-studios'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'conditioner', 'iSlay Studios Conditioner',
            'Deep-moisturizing conditioner that pairs with our shampoo.',
            1999, NULL, true, 2
       FROM public.clients WHERE slug = 'islay-studios'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,
    `INSERT INTO public.merch_products
       (client_id, product_key, name, description, base_price_cents, image_url, is_active, sort_order)
     SELECT id, 'beard-oil', 'iSlay Studios Beard Oil',
            'Lightweight beard oil with a smooth finish.',
            1999, NULL, true, 3
       FROM public.clients WHERE slug = 'islay-studios'
     ON CONFLICT (client_id, product_key) DO NOTHING;`,

    // ----- clients.processing_fee_cents: flat per-order fee -----
    // Override the platform default ($3 = 300¢) for an individual
    // tenant. Null means "use the env / code default".
    `ALTER TABLE public.clients
       ADD COLUMN IF NOT EXISTS processing_fee_cents integer
       CHECK (processing_fee_cents IS NULL OR processing_fee_cents >= 0);`,
    `COMMENT ON COLUMN public.clients.processing_fee_cents IS
       'Flat per-order processing fee (cents) charged to the customer and routed to GoElev8 alongside platform_fee_pct. NULL = use the platform default (PROCESSING_FEE_DEFAULT_CENTS, currently 300 = $3).';`,

    // ----- merch_orders.processing_fee_cents: per-order recorded fee -----
    // Mirrors the value the storefront passed in. Needed so the
    // Orders dashboard can show the full breakdown and so refunds
    // know exactly how much of the customer total was the platform's.
    `ALTER TABLE public.merch_orders
       ADD COLUMN IF NOT EXISTS processing_fee_cents integer NOT NULL DEFAULT 0
       CHECK (processing_fee_cents >= 0);`,

    // ----- booking_blocked_dates: one-off date blackouts -----
    // Lets a client take a specific date (or date range) off without
    // editing their recurring weekly availability templates. The
    // booking widgets query this table and skip any blocked date
    // when rendering the calendar.
    //   start_time / end_time NULL  → entire day blocked
    //   start_time / end_time set   → only that window blocked
    `CREATE TABLE IF NOT EXISTS public.booking_blocked_dates (
       id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       client_id   uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
       blocked_date date NOT NULL,
       start_time  time,
       end_time    time,
       reason      text,
       created_at  timestamptz NOT NULL DEFAULT now(),
       created_by  uuid REFERENCES auth.users(id)
     );`,
    `CREATE UNIQUE INDEX IF NOT EXISTS booking_blocked_dates_client_date_window_uniq
       ON public.booking_blocked_dates(client_id, blocked_date, COALESCE(start_time, '00:00:00'::time), COALESCE(end_time, '23:59:59'::time));`,
    `CREATE INDEX IF NOT EXISTS booking_blocked_dates_client_date_idx
       ON public.booking_blocked_dates(client_id, blocked_date);`,
    `ALTER TABLE public.booking_blocked_dates ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS booking_blocked_dates_admin_all ON public.booking_blocked_dates;`,
    `CREATE POLICY booking_blocked_dates_admin_all ON public.booking_blocked_dates
       FOR ALL TO authenticated
       USING ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
              OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()))
       WITH CHECK ((auth.jwt() ->> 'email') = 'ab@goelev8.ai'
                   OR EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));`,
    `DROP POLICY IF EXISTS booking_blocked_dates_member_all ON public.booking_blocked_dates;`,
    `CREATE POLICY booking_blocked_dates_member_all ON public.booking_blocked_dates
       FOR ALL TO authenticated
       USING (client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid()))
       WITH CHECK (client_id IN (SELECT client_id FROM public.client_users WHERE user_id = auth.uid()));`
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
  //
  // Cost source priority: Postgres setting (what the live trigger uses)
  // > env var > 1¢ default. Reading the DB setting first means a
  // backfill never disagrees with subsequent live trigger writes.
  let perSeg = parseInt(process.env.TWILIO_COST_PER_SEGMENT_CENTS || '1', 10);
  try {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    const projectRef = new URL(process.env.SUPABASE_URL || '').host.split('.')[0];
    if (token && projectRef) {
      const r = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: "SELECT current_setting('app.twilio_cost_cents', true) AS cents" })
      });
      const j = await r.json().catch(() => null);
      const row = Array.isArray(j) ? j[0] : (j?.[0] || null);
      const dbCents = row?.cents ? parseInt(row.cents, 10) : null;
      if (Number.isFinite(dbCents)) perSeg = dbCents;
    }
  } catch {}

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
      case 'twilio-cost':              return await twilioCostSetting(req, res);
      case 'twilio-reserve-diagnose':  return await twilioReserveDiagnose(req, res);
      case 'create-onboarding-link':   return await createOnboardingPaymentLink(req, res);
      case 'onboard-pending-tenants':  return await onboardPendingTenants(req, res);
      case 'verify-migrations':         return await verifyMigrations(req, res);
      case 'sales-dashboard':           return await salesDashboard(req, res);
      case 'dedupe-leads':              return await dedupeLeads(req, res);
      case 'dedupe-contacts':           return await dedupeContacts(req, res);
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
