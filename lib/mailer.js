// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Single source of outgoing email for the GoElev8 portal.
//
// Every email this helper sends is BCC'd to OPERATOR_BCC so the operator
// has visibility on every transactional / auth / notification message
// leaving the platform. The BCC is baked into the helper — never accept
// a `bcc` argument from callers, so no future contributor can forget it.
//
// Env required:
//   RESEND_API_KEY — set in Vercel, never committed
// Env optional:
//   RESEND_FROM    — verified sender, e.g. 'GoElev8.ai <noreply@goelev8.ai>'
//                    Defaults to Resend's onboarding sandbox (only delivers
//                    to the account owner's email — fine for first-day testing).

import { Resend } from 'resend';

const OPERATOR_BCC = 'theaiexitstrategy@gmail.com';
const DEFAULT_FROM = process.env.RESEND_FROM || 'GoElev8.ai <onboarding@resend.dev>';

// Lazy client — survives a missing API key at import time so cold-start
// of unrelated routes doesn't crash. Throws only when sendMail is actually
// called without a key configured.
let _client = null;
function client() {
  if (_client) return _client;
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY env var not set in Vercel');
  }
  _client = new Resend(process.env.RESEND_API_KEY);
  return _client;
}

// Send a transactional email. The operator BCC is appended automatically.
// Returns Resend's response on success, throws on failure.
export async function sendMail({ to, subject, html, text, from, replyTo }) {
  if (!to)      throw new Error('mailer: to required');
  if (!subject) throw new Error('mailer: subject required');
  if (!html && !text) throw new Error('mailer: html or text required');

  const recipients = Array.isArray(to) ? to : [to];
  // Always BCC the operator. Append rather than overwrite so callers can
  // never accidentally drop it. (No `bcc` parameter is exposed.)
  const bcc = [OPERATOR_BCC];

  const payload = {
    from: from || DEFAULT_FROM,
    to: recipients,
    bcc,
    subject,
    html,
    text
  };
  if (replyTo) payload.reply_to = replyTo;

  const res = await client().emails.send(payload);
  if (res?.error) {
    throw new Error(`Resend send failed: ${res.error.message || JSON.stringify(res.error)}`);
  }
  return res?.data || res;
}

// Branded password-reset / set-password email template. Used by both the
// /api/auth?action=forgot-password endpoint and the new-tenant onboarding
// flow in api/admin.js. Logo references portal.goelev8.ai/logo.png so it
// stays in sync with whatever's deployed.
export function passwordResetEmail({ recovery_url, headline, intro, button_label }) {
  const portal = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
  const heading = headline    || 'Reset your password';
  const lead    = intro       || 'We received a request to reset the password on your GoElev8.ai portal account. Click the button below to choose a new one. If you didn\'t request this, you can ignore this email.';
  const cta     = button_label || 'Set new password →';

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#e5e5e5;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#111;border:1px solid #222;border-radius:12px;padding:36px 32px;max-width:520px;">
        <tr><td align="center" style="padding-bottom:24px;">
          <img src="${portal}/logo.png" alt="GoElev8.ai" width="120" style="display:block;height:auto;max-width:120px;" />
        </td></tr>
        <tr><td style="font-size:22px;font-weight:600;color:#fff;padding-bottom:8px;">${heading}</td></tr>
        <tr><td style="font-size:14px;color:#a3a3a3;line-height:1.55;padding-bottom:24px;">${lead}</td></tr>
        <tr><td align="center" style="padding-bottom:28px;">
          <a href="${recovery_url}" style="display:inline-block;background:#fff;color:#0a0a0a;font-weight:600;font-size:14px;text-decoration:none;padding:13px 28px;border-radius:8px;">${cta}</a>
        </td></tr>
        <tr><td style="font-size:12px;color:#737373;line-height:1.5;border-top:1px solid #222;padding-top:18px;">
          This link expires in 1 hour. If the button doesn't work, copy and paste this URL into your browser:<br/>
          <span style="color:#a3a3a3;word-break:break-all;">${recovery_url}</span>
        </td></tr>
        <tr><td align="center" style="padding-top:24px;font-size:11px;color:#525252;letter-spacing:0.06em;text-transform:uppercase;">
          Powered by GoElev8 AI Infrastructure
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  // Plain-text fallback for clients that block HTML.
  const text = `${heading}\n\n${lead}\n\n${cta}: ${recovery_url}\n\nThis link expires in 1 hour.\n\nGoElev8 AI Infrastructure`;
  return { html, text };
}
