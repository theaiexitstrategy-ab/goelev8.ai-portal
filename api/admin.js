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
  if (ids.length) {
    const { data: rows } = await supabaseAdmin
      .from('messages')
      .select('client_id')
      .in('client_id', ids)
      .eq('direction', 'outbound')
      .gte('created_at', since);
    for (const r of rows || []) usage[r.client_id] = (usage[r.client_id] || 0) + 1;
  }
  return res.status(200).json({
    clients: clients.map((c) => ({ ...c, sent_30d: usage[c.id] || 0 }))
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

async function ensureDefaultClients(req, res) {
  const required = [
    { slug: 'dlp', name: 'DLP' },
    { slug: 'goelev8', name: 'GoElev8.ai' },
    { slug: 'flex-facility', name: 'The Flex Facility' },
    { slug: 'islay-studios', name: 'iSlay Studios' }
  ];
  const { data: existing } = await supabaseAdmin
    .from('clients').select('id, slug, name');
  const existingSlugs = new Set((existing || []).map(c => c.slug));
  const existingNames = new Set((existing || []).map(c => (c.name || '').toLowerCase()));
  const toInsert = required.filter(r =>
    !existingSlugs.has(r.slug) && !existingNames.has(r.name.toLowerCase())
  );
  let inserted = 0;
  if (toInsert.length) {
    const { error } = await supabaseAdmin.from('clients').insert(toInsert);
    if (error) return res.status(400).json({ error: error.message });
    inserted = toInsert.length;
  }
  return res.status(200).json({ ensured: required.length, inserted });
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
      case 'ensure-default-clients': return await ensureDefaultClients(req, res);
      case 'analytics':      return await analytics(req, res);
      case 'list-admins':    return await listAdmins(req, res);
      default:               return res.status(400).json({ error: 'unknown_action' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal_error' });
  }
}
