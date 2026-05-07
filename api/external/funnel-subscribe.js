// (c) 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cross-origin subscribe endpoint for external sites (e.g. theaiexitstrategy.com).
// Auth is a per-funnel bearer token from funnel_api_keys — sha256(raw_key)
// must match a non-revoked row.
//
// Vanilla Vercel serverless function (matches goelev8-portal style).
// Tables expected: funnel_api_keys, funnel_subscribers (created via migration
// 20260505000000_funnel_subscribers_and_api_keys.sql in goelev8-funnels —
// same Supabase project).

import crypto from 'node:crypto';
import { supabaseAdmin } from '../../lib/supabase.js';
import { methodGuard, readJson } from '../../lib/auth.js';

function hashKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function strip(v) {
  return String(v).replace(/<[^>]*>/g, '').trim();
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

  const email = String(body?.email || '').toLowerCase().trim();
  if (!email || !email.includes('@') || email.length > 200) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  const phone = body.phone ? String(body.phone).slice(0, 20) : null;
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

  // Fire-and-forget last_used_at update so revoked/dormant keys can be audited.
  supabaseAdmin
    .from('funnel_api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', keyRow.id)
    .then(() => {})
    .catch(() => {});

  return res.status(201).json({ message: 'subscribed' });
}
