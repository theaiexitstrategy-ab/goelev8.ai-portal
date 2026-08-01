// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Google Calendar API client — raw fetch, no SDK. Just enough surface
// to run the two-way sync:
//   OAuth code → tokens
//   refresh access token
//   userinfo (so we can label the connected account)
//   calendarList (so tenant can pick which calendar to sync)
//   events.list (initial + incremental with syncToken)
//   events.insert / patch / delete
//   channels.watch / stop (push notification subscription)
//
// Requires Vercel env vars:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI          — e.g. https://portal.goelev8.ai/api/portal/gcal?action=callback
//   GCAL_PUSH_WEBHOOK_URL        — e.g. https://portal.goelev8.ai/api/webhook/google-calendar-push
//   GCAL_PUSH_TOKEN              — random string; validated on push notification
//
// Every helper throws on network / auth error; callers translate to
// HTTP responses. Never logs tokens.

import { supabaseAdmin } from './supabase.js';

const G_OAUTH   = 'https://oauth2.googleapis.com';
const G_API     = 'https://www.googleapis.com';
const CAL_API   = `${G_API}/calendar/v3`;
const SCOPES    = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid', 'email'
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`env ${name} not set — add it in Vercel`);
  return v;
}

// ─── OAuth ──────────────────────────────────────────────────────
export function buildAuthUrl({ state }) {
  const params = new URLSearchParams({
    client_id:     requireEnv('GOOGLE_CLIENT_ID'),
    redirect_uri:  requireEnv('GOOGLE_REDIRECT_URI'),
    response_type: 'code',
    scope:         SCOPES.join(' '),
    access_type:   'offline',    // required for a refresh_token
    prompt:        'consent',    // forces refresh_token even on re-auth
    include_granted_scopes: 'true',
    state
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id:     requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    redirect_uri:  requireEnv('GOOGLE_REDIRECT_URI'),
    grant_type:    'authorization_code'
  });
  const res = await fetch(`${G_OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json();
  if (!res.ok) throw new Error('gcal_exchange_failed: ' + (json.error_description || json.error || res.status));
  // json: { access_token, expires_in, refresh_token?, scope, id_token? }
  return json;
}

export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     requireEnv('GOOGLE_CLIENT_ID'),
    client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
    grant_type:    'refresh_token'
  });
  const res = await fetch(`${G_OAUTH}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await res.json();
  if (!res.ok) throw new Error('gcal_refresh_failed: ' + (json.error_description || json.error || res.status));
  return json;   // { access_token, expires_in, scope }
}

// ─── Load + refresh a tenant's tokens (used by every API call) ──
export async function loadTenantTokens(clientId) {
  const { data, error } = await supabaseAdmin
    .from('client_google_calendar').select('*').eq('client_id', clientId).maybeSingle();
  if (error) throw new Error('cgc_load: ' + error.message);
  if (!data)  throw new Error('cgc_not_connected');
  if (!data.access_token && !data.refresh_token) throw new Error('cgc_tokens_missing');

  // Refresh proactively — 60s buffer to avoid mid-request expiry.
  const now = Date.now();
  const exp = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  if (!data.access_token || exp - now < 60_000) {
    if (!data.refresh_token) throw new Error('cgc_refresh_token_missing');
    const t = await refreshAccessToken(data.refresh_token);
    const newExp = new Date(Date.now() + (t.expires_in || 3600) * 1000).toISOString();
    await supabaseAdmin.from('client_google_calendar')
      .update({ access_token: t.access_token, token_expires_at: newExp, updated_at: new Date().toISOString() })
      .eq('client_id', clientId);
    data.access_token = t.access_token;
    data.token_expires_at = newExp;
  }
  return data;
}

async function callGoogle(accessToken, path, opts = {}) {
  const res = await fetch(CAL_API + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type':  'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
  if (!res.ok) {
    const msg = json?.error?.message || `gcal_http_${res.status}`;
    const err = new Error('gcal: ' + msg);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return json;
}

// ─── Userinfo (label the connected account) ─────────────────────
export async function userinfo(accessToken) {
  const res = await fetch(`${G_API}/oauth2/v3/userinfo`, {
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });
  if (!res.ok) throw new Error('gcal_userinfo_failed: ' + res.status);
  return res.json();
}

// ─── Calendar list (let tenant pick which calendar to sync) ─────
export async function listCalendars(accessToken) {
  const j = await callGoogle(accessToken, '/users/me/calendarList?maxResults=100');
  return (j.items || []).map(c => ({
    id: c.id, summary: c.summary, primary: !!c.primary,
    accessRole: c.accessRole, backgroundColor: c.backgroundColor
  }));
}

// ─── Events sync (busy → portal) ────────────────────────────────
// Incremental sync with syncToken. On first call OR when syncToken
// is null/invalid, fall back to a full pull for the next ~60 days.
export async function listEventsIncremental(accessToken, calendarId, { syncToken, timeMin, timeMax } = {}) {
  const params = new URLSearchParams();
  params.set('singleEvents', 'true');
  params.set('maxResults',   '250');
  if (syncToken) {
    params.set('syncToken', syncToken);
  } else {
    if (timeMin) params.set('timeMin', timeMin);
    if (timeMax) params.set('timeMax', timeMax);
    params.set('orderBy', 'startTime');
  }
  const path = `/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const items = [];
  let nextPageToken = null, nextSyncToken = null;
  let url = path;
  for (let i = 0; i < 20; i++) {   // hard page cap
    const j = await callGoogle(accessToken, url + (nextPageToken ? `&pageToken=${nextPageToken}` : ''));
    if (Array.isArray(j.items)) items.push(...j.items);
    nextPageToken = j.nextPageToken || null;
    nextSyncToken = j.nextSyncToken || nextSyncToken;
    if (!nextPageToken) break;
  }
  return { items, syncToken: nextSyncToken };
}

// ─── Event CRUD (portal → Google, for confirmed bookings) ───────
export async function insertEvent(accessToken, calendarId, event) {
  return await callGoogle(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(event)
  });
}
export async function updateEvent(accessToken, calendarId, eventId, patch) {
  return await callGoogle(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch)
  });
}
export async function deleteEvent(accessToken, calendarId, eventId) {
  try {
    await callGoogle(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    return { ok: true };
  } catch (e) {
    if (e.status === 404 || e.status === 410) return { ok: true, already_gone: true };
    throw e;
  }
}

// ─── Push channel watch/stop ────────────────────────────────────
// Google POSTs a small JSON body every time this calendar changes.
// We MUST call stop() before creating a new channel if one exists,
// otherwise Google will keep sending on the old channel until it
// expires (~7 days).
export async function watchCalendar(accessToken, calendarId, { channelId, token, expirationMs }) {
  const body = {
    id: channelId,
    type: 'web_hook',
    address: requireEnv('GCAL_PUSH_WEBHOOK_URL'),
    token,
    // Google's max is ~7 days but they may enforce a shorter one.
    // Passing expiration is optional — omitting lets Google pick.
    ...(expirationMs ? { expiration: String(expirationMs) } : {})
  };
  const j = await callGoogle(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return { channelId: j.id, resourceId: j.resourceId, expiration: j.expiration ? new Date(Number(j.expiration)).toISOString() : null };
}
export async function stopChannel(accessToken, channelId, resourceId) {
  if (!channelId || !resourceId) return { ok: true, skipped: true };
  try {
    await callGoogle(accessToken, `/channels/stop`, {
      method: 'POST',
      body: JSON.stringify({ id: channelId, resourceId })
    });
    return { ok: true };
  } catch (e) {
    if (e.status === 404 || e.status === 410) return { ok: true, already_gone: true };
    return { ok: false, error: e.message };
  }
}

// ─── Materialize Google events → google_calendar_busy cache ─────
// Called after every sync. Applies the delta from listEventsIncremental
// to the busy cache: `status: 'cancelled'` deletes, others upsert.
// Events marked transparency='transparent' are ignored (per Google
// convention, those don't block time).
export async function syncBusyCache(clientId, calendarId, items) {
  let removed = 0, upserted = 0, skipped = 0;
  for (const ev of items || []) {
    if (ev.status === 'cancelled') {
      await supabaseAdmin.from('google_calendar_busy')
        .delete().eq('client_id', clientId).eq('event_id', ev.id);
      removed++;
      continue;
    }
    if (ev.transparency === 'transparent') { skipped++; continue; }
    const startsAt = ev.start?.dateTime || (ev.start?.date ? ev.start.date + 'T00:00:00Z' : null);
    const endsAt   = ev.end?.dateTime   || (ev.end?.date   ? ev.end.date + 'T00:00:00Z'   : null);
    if (!startsAt || !endsAt) { skipped++; continue; }
    await supabaseAdmin.from('google_calendar_busy').upsert({
      client_id: clientId,
      event_id:  ev.id,
      starts_at: startsAt,
      ends_at:   endsAt,
      summary:   ev.summary || null,
      cached_at: new Date().toISOString()
    }, { onConflict: 'client_id,event_id' });
    upserted++;
  }
  return { removed, upserted, skipped };
}
