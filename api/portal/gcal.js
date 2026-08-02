// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Google Calendar OAuth + admin surface. Tenant owner clicks Connect
// in the Settings panel → we redirect them to Google → callback comes
// back here with a code → we exchange for tokens, persist, run an
// initial sync, and subscribe to push notifications.
//
// Routes:
//   GET  ?action=status         → { connected, google_email, calendar_id, ... }
//   POST ?action=start          → { url }  (SPA opens this URL in a popup or full navigation)
//   GET  ?action=callback       redirect back from Google. Redirects the
//                                browser to /?tab=settings&gcal=connected.
//   POST ?action=set-calendar   body { calendar_id }  — tenant picks
//                                which of their calendars to sync with
//   GET  ?action=calendars      → { calendars: [...] } (for the picker)
//   POST ?action=sync-now       manual re-sync (also called after
//                                calendar_id change)
//   POST ?action=disconnect     revoke + delete row + stop channel
//
// SECURITY
//   - Tokens never leave the server. Endpoint returns booleans /
//     labels only; NEVER access_token or refresh_token.
//   - state parameter carries the tenant's client_id, signed with
//     PORTAL_STATE_SECRET (falls back to CRON_SECRET or a dev
//     hardcode in local). Callback verifies the signature so a
//     hostile URL can't attach Stephen's Google account to another
//     tenant.

import { createHmac } from 'node:crypto';
import { requireUser } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import {
  buildAuthUrl, exchangeCode, refreshAccessToken, userinfo,
  listCalendars, listEventsIncremental, syncBusyCache,
  watchCalendar, stopChannel, loadTenantTokens
} from '../../lib/gcal.js';

const STATE_SECRET_ENV = process.env.PORTAL_STATE_SECRET || process.env.CRON_SECRET || 'dev-only-state-secret';

function signState(payload) {
  const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', STATE_SECRET_ENV).update(raw).digest('base64url');
  return raw + '.' + mac;
}
function verifyState(token) {
  const [raw, mac] = String(token || '').split('.');
  if (!raw || !mac) return null;
  const expect = createHmac('sha256', STATE_SECRET_ENV).update(raw).digest('base64url');
  if (mac !== expect) return null;
  try { const p = JSON.parse(Buffer.from(raw, 'base64url').toString()); return (p.exp && Date.now() > p.exp) ? null : p; }
  catch { return null; }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; });
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

// Fetch → subscribe → cache. Idempotent-ish (stops any existing
// channel before creating a new one).
async function runInitialSync(clientId) {
  const row = await loadTenantTokens(clientId);
  const calId = row.calendar_id || 'primary';

  // Pull the near-future window (~90 days).
  const timeMin = new Date().toISOString();
  const timeMax = new Date(Date.now() + 90 * 86400_000).toISOString();
  const { items, syncToken } = await listEventsIncremental(row.access_token, calId, { timeMin, timeMax });
  const applied = await syncBusyCache(clientId, calId, items);

  // Stop the old push channel (if any) so Google doesn't keep
  // pinging it. Best-effort — a channel that's already expired
  // returns 404 which stopChannel treats as ok.
  if (row.channel_id && row.channel_resource_id) {
    await stopChannel(row.access_token, row.channel_id, row.channel_resource_id);
  }
  // Subscribe to push notifications on the calendar. If GCAL_PUSH_
  // WEBHOOK_URL isn't set (local dev), skip watch and fall back to
  // the cron poll.
  let channel = null;
  try {
    if (process.env.GCAL_PUSH_WEBHOOK_URL) {
      channel = await watchCalendar(row.access_token, calId, {
        channelId: 'kb-' + clientId.slice(0, 8) + '-' + Date.now().toString(36),
        token:     process.env.GCAL_PUSH_TOKEN || 'nopush',
        expirationMs: Date.now() + 6 * 86400_000  // 6 days; cron renews at 5
      });
    }
  } catch (e) {
    // Watch failure is not fatal — the cron polls every 15 min.
    console.warn('[gcal] watch failed:', e.message);
  }

  await supabaseAdmin.from('client_google_calendar').update({
    sync_token:          syncToken || row.sync_token,
    last_synced_at:      new Date().toISOString(),
    last_sync_error:     null,
    channel_id:          channel?.channelId  || null,
    channel_resource_id: channel?.resourceId || null,
    channel_expiration:  channel?.expiration || null,
    updated_at:          new Date().toISOString()
  }).eq('client_id', clientId);

  return { synced: applied, watch: channel ? 'subscribed' : 'polling_fallback' };
}

// ─── GET ?action=status ─────────────────────────────────────────
async function handleStatus(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const { data } = await supabaseAdmin
    .from('client_google_calendar')
    .select('client_id, google_email, calendar_id, calendar_summary, connected_at, last_synced_at, last_sync_error, channel_expiration, scopes')
    .eq('client_id', r.clientId).maybeSingle();
  return res.status(200).json({
    connected: !!data,
    ...(data || {}),
    // Never expose tokens.
    access_token: undefined, refresh_token: undefined, token_expires_at: undefined
  });
}

// ─── POST ?action=start ─────────────────────────────────────────
async function handleStart(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const state = signState({ client_id: r.clientId, exp: Date.now() + 10 * 60_000 });
  try { return res.status(200).json({ url: buildAuthUrl({ state }) }); }
  catch (e) { return res.status(500).json({ error: 'gcal_config_missing', message: e.message }); }
}

// ─── GET ?action=callback (Google redirects here) ──────────────
async function handleCallback(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  const portalBase = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
  const done = (params) => res.writeHead(302, { Location: `${portalBase}/?tab=connect&${new URLSearchParams(params)}` }).end();

  if (err) return done({ gcal: 'error', reason: err });
  if (!code || !state) return done({ gcal: 'error', reason: 'missing_params' });
  const parsed = verifyState(state);
  if (!parsed?.client_id) return done({ gcal: 'error', reason: 'bad_state' });

  try {
    const t = await exchangeCode(code);
    if (!t.refresh_token) {
      // Google only issues a refresh_token when prompt=consent AND
      // access_type=offline (we set both) — but if the user has
      // ALREADY consented we still won't get one on the return trip.
      // Solution: revoke prior access at accounts.google.com and
      // reconnect. Surface the specific failure so the SPA can tell
      // Stephen the fix.
      return done({ gcal: 'error', reason: 'no_refresh_token' });
    }
    // Grab userinfo to label the connection
    const ui = await userinfo(t.access_token);
    const expiresAt = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
    const scopes = String(t.scope || '').split(/\s+/).filter(Boolean);
    await supabaseAdmin.from('client_google_calendar').upsert({
      client_id:        parsed.client_id,
      google_email:     ui.email || null,
      google_account_id: ui.sub || null,
      calendar_id:      'primary',
      calendar_summary: 'Primary',
      access_token:     t.access_token,
      refresh_token:    t.refresh_token,
      token_expires_at: expiresAt,
      scopes,
      connected_at:     new Date().toISOString(),
      updated_at:       new Date().toISOString(),
      // Clear stale channel + sync state on re-connect.
      channel_id: null, channel_resource_id: null, channel_expiration: null,
      sync_token: null, last_synced_at: null, last_sync_error: null
    }, { onConflict: 'client_id' });

    // Best-effort initial sync — if it fails, tenant sees connected
    // and the cron will retry every 15 min.
    try { await runInitialSync(parsed.client_id); }
    catch (e) {
      console.warn('[gcal] initial sync failed:', e.message);
      await supabaseAdmin.from('client_google_calendar')
        .update({ last_sync_error: e.message }).eq('client_id', parsed.client_id);
    }
    return done({ gcal: 'connected' });
  } catch (e) {
    console.error('[gcal] callback failed:', e.message);
    return done({ gcal: 'error', reason: 'exchange_failed', detail: e.message.slice(0, 200) });
  }
}

// ─── GET ?action=calendars — list picker ───────────────────────
async function handleListCalendars(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    const row = await loadTenantTokens(r.clientId);
    const cals = await listCalendars(row.access_token);
    return res.status(200).json({ calendars: cals });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}

// ─── POST ?action=set-calendar ─────────────────────────────────
async function handleSetCalendar(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  const body = await readJson(req);
  const calId = String(body?.calendar_id || '').trim();
  if (!calId) return res.status(400).json({ error: 'calendar_id_required' });
  const summary = body?.calendar_summary ? String(body.calendar_summary).slice(0, 200) : null;
  // Reset sync state — new calendar, new syncToken.
  await supabaseAdmin.from('client_google_calendar').update({
    calendar_id: calId, calendar_summary: summary,
    sync_token: null, last_synced_at: null, last_sync_error: null,
    updated_at: new Date().toISOString()
  }).eq('client_id', r.clientId);
  // Clear existing busy cache — belongs to the old calendar.
  await supabaseAdmin.from('google_calendar_busy').delete().eq('client_id', r.clientId);
  // Re-sync against new calendar.
  try { const applied = await runInitialSync(r.clientId); return res.status(200).json({ ok: true, applied }); }
  catch (e) { return res.status(500).json({ error: 'resync_failed', message: e.message }); }
}

// ─── POST ?action=sync-now ─────────────────────────────────────
async function handleSyncNow(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  try { const applied = await runInitialSync(r.clientId); return res.status(200).json({ ok: true, applied }); }
  catch (e) { return res.status(500).json({ error: 'sync_failed', message: e.message }); }
}

// ─── POST ?action=disconnect ───────────────────────────────────
async function handleDisconnect(req, res) {
  const ctx = await requireUser(req, res, { requireClient: false });
  if (!ctx) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const r = await resolveClientId(ctx, url);
  if (r.error) return res.status(400).json({ error: r.error });
  // Load current row to stop its push channel + best-effort revoke.
  const { data: row } = await supabaseAdmin
    .from('client_google_calendar').select('access_token, refresh_token, channel_id, channel_resource_id')
    .eq('client_id', r.clientId).maybeSingle();
  if (row) {
    try { if (row.channel_id) await stopChannel(row.access_token, row.channel_id, row.channel_resource_id); } catch {}
    // Revoke the refresh token so Google knows we're done.
    try {
      if (row.refresh_token) {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(row.refresh_token), { method: 'POST' });
      }
    } catch {}
  }
  await supabaseAdmin.from('client_google_calendar').delete().eq('client_id', r.clientId);
  await supabaseAdmin.from('google_calendar_busy').delete().eq('client_id', r.clientId);
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  // Callback is a GET the browser follows from Google. All other
  // actions are portal-authed.
  if (action === 'callback') return await handleCallback(req, res);

  if (req.method === 'GET') {
    if (action === 'status')    return await handleStatus(req, res);
    if (action === 'calendars') return await handleListCalendars(req, res);
    return res.status(400).json({ error: 'unknown_action', action });
  }
  if (req.method === 'POST') {
    if (action === 'start')        return await handleStart(req, res);
    if (action === 'set-calendar') return await handleSetCalendar(req, res);
    if (action === 'sync-now')     return await handleSyncNow(req, res);
    if (action === 'disconnect')   return await handleDisconnect(req, res);
    return res.status(400).json({ error: 'unknown_action', action });
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}

// Re-exported for the push webhook to avoid duplicating sync logic.
export { runInitialSync };
