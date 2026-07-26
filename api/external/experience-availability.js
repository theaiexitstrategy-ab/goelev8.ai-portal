// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Public GET endpoint that returns real availability for a tenant
// over a date range. Replaces the KK site's client-side buildDays()
// + hardcoded SLOTS array (which currently allows double-booking).
//
// Slots = (weekly rules for that DOW) − (blocks that overlap) −
//   (existing confirmed/deposit_pending bookings that overlap).
//
// Auth: tenant write key (same as leads endpoint). Read-only, but
// gated so anonymous scrapers can't enumerate the calendar.
//
// Query:
//   ?from=YYYY-MM-DD    (required, inclusive)
//   ?to=YYYY-MM-DD      (required, inclusive; capped to 60 days out)
//   ?experience_key=... (optional; if a rule is experience-specific)
//
// Response:
//   {
//     tz: 'America/Chicago',
//     days: [
//       { date: 'YYYY-MM-DD', slots: [{ starts_at: '<ISO with tz>', duration_min }] },
//       ...
//     ]
//   }

import { supabaseAdmin } from '../../lib/supabase.js';
import { authTenantWriteKey, setCorsHeaders } from '../../lib/tenant-write-key.js';

const MAX_RANGE_DAYS = 60;

// Compute "YYYY-MM-DD" for a Date in a given IANA timezone. Avoids
// UTC-drift bugs at midnight boundaries.
function ymdInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}
function dayOfWeekInTz(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).formatToParts(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[parts.find(p => p.type === 'weekday').value] ?? 0;
}

// Build an ISO 8601 string like '2026-07-26T19:00:00-05:00' for a
// specific date + local time in a given timezone. Uses the "wall
// clock rebuilding" trick — construct the datetime naive, then
// query Intl for the actual offset that IANA tz would apply for
// that wall time, and stamp the offset in.
function isoInTz(dateStr, timeStr, tz) {
  // dateStr: 'YYYY-MM-DD'; timeStr: 'HH:MM' or 'HH:MM:SS'
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = timeStr.split(':').map(Number);
  // Naive UTC guess (this is the wall-clock time interpreted as UTC).
  const guess = new Date(Date.UTC(Y, M - 1, D, h, m, 0));
  // Ask Intl what the tz offset (in minutes) is at that instant, by
  // formatting the guess IN the target tz and comparing back.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(guess);
  const localY  = parseInt(parts.find(p => p.type === 'year').value, 10);
  const localMo = parseInt(parts.find(p => p.type === 'month').value, 10);
  const localD  = parseInt(parts.find(p => p.type === 'day').value, 10);
  const localH  = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
  const localMi = parseInt(parts.find(p => p.type === 'minute').value, 10);
  const localAsUtc = Date.UTC(localY, localMo - 1, localD, localH, localMi, 0);
  const offsetMin = (guess.getTime() - localAsUtc) / 60000;
  // The wall-clock time we wanted, in UTC millis, is: guess - offset
  const actualUtcMs = guess.getTime() - offsetMin * 60000;
  const iso = new Date(actualUtcMs).toISOString().slice(0, 19);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${iso}${sign}${oh}:${om}`;
}

function addDaysYmd(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Generate hh:mm strings from start_time up to end_time in
// slot_duration_min increments.
function expandSlotTimes(startTime, endTime, durationMin) {
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
  const startMin = toMin(startTime);
  const endMin   = toMin(endTime);
  const out = [];
  for (let t = startMin; t + durationMin <= endMin; t += durationMin) {
    const h = Math.floor(t / 60), m = t % 60;
    out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCorsHeaders(res, req.headers.origin || '*');
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = await authTenantWriteKey(req);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
  setCorsHeaders(res, auth.corsOrigin);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');
  const experienceKey = url.searchParams.get('experience_key');
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return res.status(400).json({ ok: false, error: 'from_YYYY-MM-DD_required' });
  if (!to   || !/^\d{4}-\d{2}-\d{2}$/.test(to))   return res.status(400).json({ ok: false, error: 'to_YYYY-MM-DD_required' });
  if (to < from) return res.status(400).json({ ok: false, error: 'to_before_from' });

  // Cap the range to keep the compute bounded.
  const fromDate = new Date(from + 'T00:00:00Z');
  let   toDate   = new Date(to   + 'T00:00:00Z');
  const maxDate  = new Date(fromDate.getTime() + MAX_RANGE_DAYS * 86400_000);
  if (toDate > maxDate) toDate = maxDate;
  const toStr = toDate.toISOString().slice(0, 10);

  // Resolve tenant timezone (fall back America/Chicago).
  const { data: clientRow } = await supabaseAdmin
    .from('clients').select('id, timezone').eq('id', auth.clientId).maybeSingle();
  const tz = clientRow?.timezone || 'America/Chicago';

  // Weekly rules
  const { data: rulesRaw } = await supabaseAdmin
    .from('experience_availability_rules')
    .select('*')
    .eq('client_id', auth.clientId)
    .eq('active', true);
  const rules = (rulesRaw || []).filter(r => !r.experience_key || !experienceKey || r.experience_key === experienceKey);

  // Existing bookings that could occupy a slot in the window (from
  // 1 day before start to include events that started late the prior
  // day — durations up to 24h).
  const windowStartIso = new Date(fromDate.getTime() - 86400_000).toISOString();
  const windowEndIso   = new Date(toDate.getTime()   + 86400_000).toISOString();
  const { data: existingBookings } = await supabaseAdmin
    .from('experience_bookings')
    .select('event_starts_at, duration_min, status')
    .eq('client_id', auth.clientId)
    .in('status', ['deposit_pending', 'confirmed'])
    .gte('event_starts_at', windowStartIso)
    .lt('event_starts_at', windowEndIso);
  const { data: blocks } = await supabaseAdmin
    .from('experience_availability_blocks')
    .select('starts_at, ends_at')
    .eq('client_id', auth.clientId)
    .gte('starts_at', windowStartIso)
    .lt('starts_at', windowEndIso);

  const bookedRanges = (existingBookings || []).map(b => {
    const start = new Date(b.event_starts_at).getTime();
    const dur = (b.duration_min || 60) * 60000;
    return [start, start + dur];
  });
  const blockRanges = (blocks || []).map(b => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()]);

  const overlapsBusy = (startMs, endMs) => {
    for (const [bs, be] of bookedRanges) if (startMs < be && endMs > bs) return true;
    for (const [bs, be] of blockRanges)  if (startMs < be && endMs > bs) return true;
    return false;
  };

  // Iterate each day in the range, gather slots.
  const days = [];
  for (let ymd = from; ymd <= toStr; ymd = addDaysYmd(ymd, 1)) {
    const anchor = new Date(ymd + 'T12:00:00Z'); // noon UTC = safe within any tz's date
    const dow = dayOfWeekInTz(anchor, tz);
    const dayRules = rules.filter(r => r.day_of_week === dow);
    const slots = [];
    for (const r of dayRules) {
      const times = expandSlotTimes(r.start_time, r.end_time, r.slot_duration_min || 60);
      for (const t of times) {
        const iso = isoInTz(ymd, t, tz);
        const startMs = new Date(iso).getTime();
        const endMs = startMs + (r.slot_duration_min || 60) * 60000;
        if (overlapsBusy(startMs, endMs)) continue;
        slots.push({ starts_at: iso, duration_min: r.slot_duration_min || 60 });
      }
    }
    // De-dupe slots that repeat across rules (same starts_at), sort
    slots.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const seen = new Set();
    const unique = slots.filter(s => {
      if (seen.has(s.starts_at)) return false;
      seen.add(s.starts_at); return true;
    });
    days.push({ date: ymd, slots: unique });
  }

  return res.status(200).json({ tz, days });
}
