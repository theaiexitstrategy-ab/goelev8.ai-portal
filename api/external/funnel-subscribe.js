// (c) 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cross-origin subscribe endpoint for external sites (e.g. theaiexitstrategy.com).
// Auth: per-funnel bearer token, sha256-hashed in funnel_api_keys.
// Accepts email-only, phone-only, or both. At least one is required.
//
// Vanilla Vercel serverless function.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilio, truncateForSms } from '../../lib/twilio.js';
import { methodGuard, readJson } from '../../lib/auth.js';

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function strip(v) {
  return String(v).replace(/<[^>]*>/g, '').trim();
}

// Normalize a phone number to E.164. Returns null if the input can't be
// coerced. Assumes US country code if no leading + is present.
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (digits.length >= 10 && digits.length <= 15 && /^\d+$/.test(digits)) {
      return cleaned;
    }
    return null;
  }
  const us10 = cleaned.replace(/^1/, '');
  if (us10.length !== 10) return null;
  return `+1${us10}`;
}

// Per-funnel welcome SMS config. Add more entries as new funnels go live.
// Keyed by funnel_id; AIES is the only one for now.
const WELCOME_SMS_BY_FUNNEL = {
  '2f0d4f4b-9cfc-4ca5-b9d7-ee54eaa7e26f': {
    fromEnv: 'AIES_TWILIO_PHONE_NUMBER',
    body:
      "Welcome to The AI Exit Strategy. You'll get 3 drops a week — " +
      "practical AI income tips, Claude prompts, and free tools. " +
      "Reply STOP to opt out, HELP for help.",
  },
};

async function sendWelcomeSms(funnelId, toPhone) {
  const config = WELCOME_SMS_BY_FUNNEL[funnelId];
  if (!config) return; // No welcome SMS configured for this funnel.
  const from = process.env[config.fromEnv];
  if (!from) {
    console.warn(`[funnel-subscribe] welcome SMS skipped — ${config.fromEnv} not set`);
    return;
  }
  try {
    await twilio.messages.create({ from, to: toPhone, body: truncateForSms(config.body) });
  } catch (err) {
    // Best-effort — DB insert already succeeded, don't fail the request.
    console.error('[funnel-subscribe] welcome SMS failed:', err?.message || err);
  }
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;

  const auth = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return res.status(401).json({ error: 'Missing bearer token' });
  const rawKey = m[1].trim();
  if (!rawKey) return res.status(401).json({ error: 'Missing bearer token' });

  const keyHash = hashKey(rawKey);

  const { data: keyRow, error: keyErr } = await supabaseAdmin
    .from('funnel_api_keys')
    .select('id, funnel_id, revoked_at')
    .eq('key_hash', keyHash)
    .single();

  if (keyErr || !keyRow || keyRow.revoked_at) {
    return res.status(401).json({ error: 'Invalid or revoked key' });
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  let email = null;
  if (body?.email) {
    const candidate = String(body.email).toLowerCase().trim();
    if (candidate && (!candidate.includes('@') || candidate.length > 200)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    email = candidate || null;
  }

  let phone = null;
  if (body?.phone) {
    phone = normalizePhone(body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Invalid phone' });
    }
  }

  if (!email && !phone) {
    return res.status(400).json({ error: 'Email or phone required' });
  }

  const sms_opt_in = !!body.sms_opt_in;
  const source = body.source ? strip(body.source).slice(0, 50) : 'website_popup';
  const utm_source = body.utm_source ? strip(body.utm_source).slice(0, 100) : null;
  const utm_medium = body.utm_medium ? strip(body.utm_medium).slice(0, 100) : null;
  const utm_campaign = body.utm_campaign ? strip(body.utm_campaign).slice(0, 100) : null;

  const { error: insertErr } = await supabaseAdmin
    .from('funnel_subscribers')
    .insert({
      funnel_id: keyRow.funnel_id,
      email,
      phone,
      sms_opt_in,
      source,
      utm_source,
      utm_medium,
      utm_campaign,
    });

  if (insertErr) {
    if (insertErr.code === '23505') {
      return res.status(200).json({ message: 'already_subscribed' });
    }
    console.error('[external/funnel-subscribe] insert error:', insertErr.code);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Fire-and-forget last_used_at update.
  supabaseAdmin
    .from('funnel_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', keyRow.id)
    .then(() => {})
    .catch(() => {});

  // Best-effort welcome SMS — gives the subscriber immediate confirmation
  // and verifies the captured phone is real. Awaited so the function
  // doesn't return before Twilio responds (Vercel serverless freezes
  // post-response work), but errors are swallowed.
  if (phone && sms_opt_in) {
    await sendWelcomeSms(keyRow.funnel_id, phone);
  }

  return res.status(201).json({ message: 'subscribed' });
}
