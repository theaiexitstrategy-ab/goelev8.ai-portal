import { createClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '../lib/supabase.js';
import { requireUser, methodGuard, readJson } from '../lib/auth.js';
import { sendMail, passwordResetEmail } from '../lib/mailer.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get('action');

  if (action === 'login') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { email, password } = await readJson(req);
    if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    return res.status(200).json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      user: { id: data.user.id, email: data.user.email }
    });
  }

  if (action === 'refresh') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { refresh_token } = await readJson(req);
    if (!refresh_token) return res.status(400).json({ error: 'missing_refresh_token' });
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { data, error } = await sb.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: error.message });
    return res.status(200).json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at
    });
  }

  if (action === 'change-password') {
    if (!methodGuard(req, res, ['POST'])) return;
    const ctx = await requireUser(req, res); if (!ctx) return;
    const { new_password } = await readJson(req);
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(ctx.user.id, {
      password: new_password
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  // Public — anyone can request a password reset for their own email.
  // Always returns 200 so we don't leak which addresses are registered.
  //
  // We bypass Supabase Auth's built-in mailer (no BCC support) and
  // instead mint a recovery URL via admin.generateLink, then send the
  // branded email through lib/mailer.js which BCCs the operator on
  // every outbound message. If the email isn't registered, generateLink
  // errors silently and we still 200 to the caller.
  if (action === 'forgot-password') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { email } = await readJson(req);
    if (!email) return res.status(400).json({ error: 'missing_email' });
    const portal = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
    try {
      const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: `${portal}/?reset=1` }
      });
      if (linkErr) throw new Error(linkErr.message);
      const recoveryUrl = linkData?.properties?.action_link || linkData?.action_link;
      if (recoveryUrl) {
        const { html, text } = passwordResetEmail({ recovery_url: recoveryUrl });
        await sendMail({
          to: email,
          subject: 'Reset your GoElev8.ai password',
          html, text
        });
      }
    } catch (e) { /* swallow — don't leak existence or transport errors */ }
    return res.status(200).json({ ok: true });
  }

  // Set a new password using a recovery session. The portal's reset page
  // exchanges the recovery hash from the email link for an access token,
  // then POSTs here with that token + the new password.
  if (action === 'reset-password-with-token') {
    if (!methodGuard(req, res, ['POST'])) return;
    const { access_token, new_password } = await readJson(req);
    if (!access_token) return res.status(400).json({ error: 'missing_token' });
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: 'password_too_short' });
    }
    // Verify the recovery JWT and pull the user id off it via the admin client.
    const { data: userData, error: getErr } = await supabaseAdmin.auth.getUser(access_token);
    if (getErr || !userData?.user?.id) {
      return res.status(401).json({ error: 'invalid_or_expired_token' });
    }
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userData.user.id, {
      password: new_password
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: 'unknown_action' });
}
