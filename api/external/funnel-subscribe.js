// (c) 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cross-origin subscribe endpoint for external sites (e.g. theaiexitstrategy.com).
// Auth: per-funnel bearer token, sha256-hashed in funnel_api_keys.
// Accepts email-only, phone-only, or both. At least one is required.
//
// Vanilla Vercel serverless function.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { methodGuard, readJson } from '../../lib/auth.js';

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function strip(v) {
  return String(v).replace(/<[^>]*>/g, '').trim();
}

// Normalize a phone number to E.164 (e.g. +18885468895). Returns null if the
// input can't be coerced to a valid 10-15 digit number. Assumes US country
// code if no leading + is present.
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
  // No country code — assume US, drop a stray leading 1 if present
  const us10 = cleaned.replace(/^1/, '');
  if (us10.length !== 10) return null;
  return `+1${us10}`;
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

  // Email is optional now. If provided, must be valid.
  let email = null;
  if (body?.email) {
    const candidate = String(body.email).toLowerCase().trim();
    if (candidate && (!candidate.includes('@') || candidate.length > 200)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    email = candidate || null;
  }

  // Phone is optional. If provided, must normalize to E.164.
  let phone = null;
  if (body?.phone) {
    phone = normalizePhone(body.phone);
    if (!phone) {
      return res.status(400).json({ error: 'Invalid phone' });
    }
  }

  // At least one of email or phone is required.
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

  return res.status(201).json({ message: 'subscribed' });
}
