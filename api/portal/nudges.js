// Nudge sequence CRUD — GET / PUT for the 5-message SMS drip editor.
//
// GET  /api/portal/nudges          → list all 5 nudge slots for the client
// PUT  /api/portal/nudges          → bulk-save all nudge messages
// PUT  /api/portal/nudges?slot=N   → save a single nudge slot (1-5)

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

// ── A2P 10DLC blocked phrases (case-insensitive) ────────────────────
const BLOCKED_PHRASES = [
  'FREE', 'WINNER', 'GUARANTEED', 'RISK FREE', 'CANCEL ANYTIME',
  'CLICK HERE', 'ACT NOW', 'LIMITED TIME', 'URGENT', 'CONGRATULATIONS',
  "YOU'VE BEEN SELECTED", 'NO OBLIGATION', 'CALL NOW'
];

const OPT_OUT_PATTERNS = [
  /reply\s+stop\s+to\s+opt\s+out/i,
  /txt\s+stop\s+to\s+end/i,
  /text\s+stop\s+to\s+(end|opt\s+out|unsubscribe)/i,
  /reply\s+stop\s+to\s+(end|unsubscribe)/i
];

const OPT_OUT_SUFFIX = '\nReply STOP to opt out.';

// Only goelev8.ai URLs allowed
const URL_RE = /https?:\/\/[^\s)}\]]+/gi;

// Allowed delay_minutes per message slot
const ALLOWED_DELAYS = {
  1: [0],
  2: [30, 60, 120, 240],
  3: [720, 1440, 2880],
  4: [1440, 2880, 4320],
  5: [4320, 7200, 10080]
};

// ── Validation ──────────────────────────────────────────────────────

function validateNudge(msg, idx) {
  const errors = [];
  const num = msg.message_number ?? idx;
  let body = String(msg.message_body || '').trim();

  // Check blocked phrases
  const upper = body.toUpperCase();
  for (const phrase of BLOCKED_PHRASES) {
    if (upper.includes(phrase)) {
      errors.push(`Message ${num}: contains blocked A2P phrase "${phrase}"`);
    }
  }

  // Check URLs — only goelev8.ai domain or merge tag [funnel_url] allowed
  const urls = body.match(URL_RE) || [];
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!host.endsWith('goelev8.ai') && host !== 'goelev8.ai') {
        errors.push(`Message ${num}: URL "${url}" is not on the goelev8.ai domain`);
      }
    } catch {
      errors.push(`Message ${num}: invalid URL "${url}"`);
    }
  }

  // Message 1 must contain opt-out language — auto-append if missing
  if (num === 1) {
    const hasOptOut = OPT_OUT_PATTERNS.some((re) => re.test(body));
    if (!hasOptOut) {
      body = body + OPT_OUT_SUFFIX;
    }
  }

  // 160-char hard limit (after opt-out append)
  if (body.length > 160) {
    errors.push(`Message ${num}: ${body.length} characters exceeds the 160-character limit`);
  }

  // Validate delay
  const delay = Number(msg.delay_minutes);
  const allowed = ALLOWED_DELAYS[num];
  if (allowed && !allowed.includes(delay)) {
    errors.push(`Message ${num}: delay ${delay}m is not an allowed value (${allowed.join(', ')})`);
  }

  return { body, errors };
}

// ── Default nudge templates (matches migration seed) ────────────────

const DEFAULT_NUDGES = [
  { message_number: 1, message_body: 'Hey [first_name]! [business_name] here. We just got your info \u2014 someone will follow up shortly. Reply STOP to opt out.', delay_minutes: 0 },
  { message_number: 2, message_body: 'Still thinking it over? [business_name] is ready when you are. Check out what we offer: [funnel_url]', delay_minutes: 60 },
  { message_number: 3, message_body: 'Hey [first_name], just checking in. Spots fill up fast at [business_name]. Want to lock yours in?', delay_minutes: 1440 },
  { message_number: 4, message_body: 'Last thing \u2014 [business_name] wanted to make sure you didn\u2019t miss out. Reply back anytime.', delay_minutes: 2880 },
  { message_number: 5, message_body: 'We\u2019ll leave the door open. Come back when you\u2019re ready: [funnel_url]', delay_minutes: 4320 }
];

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PUT'])) return;
  const ctx = await requireUser(req, res);
  if (!ctx) return;
  const { clientId } = ctx;

  // ── GET: return the 5 nudge slots ──────────────────────────────────
  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('nudge_sequences')
      .select('*')
      .eq('client_id', clientId)
      .order('message_number', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    // If no rows exist yet (new client), return platform defaults
    const nudges = data?.length ? data : DEFAULT_NUDGES.map((d) => ({
      ...d,
      client_id: clientId,
      is_active: true,
      is_custom: false
    }));

    return res.status(200).json({ nudges });
  }

  // ── PUT: save nudge(s) ─────────────────────────────────────────────
  const body = await readJson(req);
  const url = new URL(req.url, 'http://x');
  const slotParam = url.searchParams.get('slot');

  // Accept either a single nudge (with ?slot=N) or an array of all 5
  let incoming;
  if (slotParam) {
    const num = parseInt(slotParam, 10);
    if (num < 1 || num > 5) return res.status(400).json({ error: 'slot must be 1-5' });
    incoming = [{ ...body, message_number: num }];
  } else {
    incoming = body.nudges;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return res.status(400).json({ error: 'provide nudges array or use ?slot=N' });
    }
  }

  // Validate all messages
  const allErrors = [];
  const validated = [];
  for (const msg of incoming) {
    const num = Number(msg.message_number);
    if (num < 1 || num > 5) {
      allErrors.push(`Invalid message_number: ${msg.message_number}`);
      continue;
    }
    const { body: cleanBody, errors } = validateNudge(msg, num);
    allErrors.push(...errors);
    validated.push({
      client_id: clientId,
      message_number: num,
      message_body: cleanBody,
      delay_minutes: Number(msg.delay_minutes) || 0,
      is_active: msg.is_active !== false,
      is_custom: true
    });
  }

  if (allErrors.length) {
    return res.status(422).json({ error: 'validation_failed', details: allErrors });
  }

  // Upsert (client_id, message_number is unique)
  const { data, error } = await supabaseAdmin
    .from('nudge_sequences')
    .upsert(validated, { onConflict: 'client_id,message_number' })
    .select('*');

  if (error) return res.status(500).json({ error: error.message });

  // Return full set after save
  const { data: all } = await supabaseAdmin
    .from('nudge_sequences')
    .select('*')
    .eq('client_id', clientId)
    .order('message_number', { ascending: true });

  return res.status(200).json({ ok: true, nudges: all || data });
}
