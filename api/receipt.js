// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// GET /r/:token  (rewritten by vercel.json → /api/receipt?token=…)
//
// 302s an attendee to the Stripe-hosted receipt for their event
// reservation. Exists because the confirmation SMS can't carry the raw
// Stripe URL: lib/twilio.js caps outbound messages at 160 characters and
// truncates at a word boundary, and a Stripe receipt_url is 120+ chars —
// it would be silently chopped into a dead link. A /r/<16 hex> token is
// ~40 chars total and leaves room for actual words.
//
// The token is opaque and random (event_reservations.receipt_token,
// defaulted in migration 0042) rather than the reservation id, so
// possessing a receipt link doesn't reveal a database id or let someone
// walk the table. It's a bearer link by design — the same trust model as
// Stripe's own receipt URLs, which are equally guessable-by-nobody.

import { supabaseAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = String(url.searchParams.get('token') || '').trim();
  // Tokens are exactly 16 lowercase hex chars. Validating the shape keeps
  // junk out of the query entirely.
  if (!/^[0-9a-f]{16}$/.test(token)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const { data, error } = await supabaseAdmin
    .from('event_reservations')
    .select('receipt_url, status')
    .eq('receipt_token', token)
    .maybeSingle();

  if (error)  return res.status(500).json({ error: 'lookup_failed' });
  if (!data)  return res.status(404).json({ error: 'not_found' });

  if (!data.receipt_url) {
    // Paid but Stripe hadn't produced the charge yet when we recorded the
    // row (or the lookup failed). Say so plainly rather than 404ing on a
    // link we just texted them.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:32px;line-height:1.5">'
      + '<h2>Receipt not ready yet</h2>'
      + '<p>Your reservation is confirmed. The payment receipt takes a moment to appear — '
      + 'please check back shortly.</p></body>'
    );
  }

  // 302 rather than 301: receipt_url is not permanent and we don't want
  // it baked into browser caches.
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(302, { Location: data.receipt_url });
  return res.end();
}
