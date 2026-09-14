// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Unsubscribe link for re-engagement emails (lib/experience-reengage.js).
//
// GET shows a confirm button; only the POST unsubscribes. Mail security
// scanners open links in emails automatically, so a GET that acted would
// silently unsubscribe guests who never clicked.
//
// The link carries the tenant id, the email (base64url) and an HMAC over
// both, so it can't be edited to unsubscribe someone else.

import { verifyUnsubscribeToken, unsubscribeEmail } from '../../lib/experience-reengage.js';

const page = (title, body, form = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#151310;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#E8D8B8;">
<div style="max-width:460px;margin:12vh auto;padding:32px;background:#123D35;border:1px solid rgba(195,154,69,.35);border-radius:14px;">
<h1 style="font-family:Georgia,serif;font-weight:600;color:#C39A45;font-size:24px;margin:0 0 12px;">${title}</h1>
<p style="line-height:1.6;margin:0;">${body}</p>${form}</div></body></html>`;

export default async function handler(req, res) {
  const q = req.query || {};
  const clientId = String(q.c || '');
  let email = '';
  try { email = Buffer.from(String(q.e || ''), 'base64url').toString('utf8'); } catch { /* invalid */ }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!/^[0-9a-f-]{36}$/i.test(clientId) || !email.includes('@') || !verifyUnsubscribeToken(clientId, email, q.t)) {
    return res.status(400).send(page('Link not recognized', 'This unsubscribe link is incomplete or has expired. Reply to any of our emails and we will remove you by hand.'));
  }

  if (req.method === 'POST') {
    try {
      await unsubscribeEmail(clientId, email);
      return res.status(200).send(page('You are unsubscribed', 'You will not receive further follow-up emails from us. If you ever want to reach us, simply reply to one of our earlier emails.'));
    } catch (e) {
      console.error('[email-unsubscribe]', e);
      return res.status(500).send(page('Something went wrong', 'We could not update your preferences just now. Please try again, or reply to any of our emails.'));
    }
  }

  const action = `?c=${encodeURIComponent(clientId)}&e=${encodeURIComponent(String(q.e))}&t=${encodeURIComponent(String(q.t))}`;
  return res.status(200).send(page('Unsubscribe', 'Stop receiving follow-up emails at this address?',
    `<form method="post" action="${action}" style="margin-top:22px;"><button type="submit" style="background:#C39A45;color:#151310;border:0;border-radius:999px;padding:12px 24px;font-weight:600;letter-spacing:1px;text-transform:uppercase;font-size:13px;cursor:pointer;">Unsubscribe</button></form>`));
}
