// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Provisioning email — sent to ab@goelev8.ai after the agent finishes
// (or partially finishes) a tenant. Pulls the Resend wiring from
// lib/mailer.js so the OPERATOR_BCC compliance rule applies here too.

import { sendMail } from './mailer.js';

const ADMIN_EMAIL = process.env.PROVISIONING_NOTIFY_EMAIL || 'ab@goelev8.ai';
const PORTAL_BASE = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bullets(items) {
  if (!items?.length) return '<em style="color:#888">(none)</em>';
  return '<ul style="margin:4px 0;padding-left:20px">' +
    items.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';
}

export async function sendProvisioningEmail({ ctx, log }) {
  const { client, info, assets } = ctx;
  const completed = (log.completed || []).map(s => s.step);
  const errors    = log.errors    || [];
  const warnings  = log.warnings  || [];

  const errored = errors.length > 0;
  const subjectIcon = errored ? '⚠️' : '✅';
  const subject = `${subjectIcon} New brand provisioned: ${client.business_name || client.slug}`;

  // Aggregate keyword + service counts for the at-a-glance summary
  // line. Best-effort — failure to count doesn't block the email.
  const serviceCount = Array.isArray(info?.services) ? info.services.length : 0;
  const keywordCount = Array.isArray(info?.keywords) ? info.keywords.length : 0;
  const assetCount   = assets?.length || 0;

  const portalUrl = `${PORTAL_BASE}/?as=${encodeURIComponent(client.slug || '')}`;
  const supabaseUrl = client.id
    ? `https://supabase.com/dashboard/project/_/editor/clients?filter=id%3Aeq%3A${client.id}`
    : null;

  // Per-step completion list. Each entry is { step, result }; the
  // result can vary (object with counts, ok: true, skipped reason).
  const completedHtml = (log.completed || []).map(s => {
    const key = s.step;
    const r = s.result || {};
    const detail =
      r.skipped       ? `skipped: ${esc(r.skipped)}` :
      r.no_changes    ? 'nothing to update' :
      r.already_present ? 'already present' :
      r.moved != null ? `${r.moved} moved · ${r.skipped} skipped` :
      r.next_action   ? `next: ${esc(r.next_action)}` :
      r.client_provided != null
        ? `${r.client_provided} client + ${r.platform_network} platform + ${r.auto} auto`
        : 'done';
    return `<li><strong>${esc(key)}</strong> — <span style="color:#555">${detail}</span></li>`;
  }).join('');

  const errorsHtml = errors.length
    ? `<div style="background:#fef2f2;border-left:3px solid #dc2626;padding:8px 12px;margin:12px 0;font-size:13px">
        <strong>Errors:</strong>
        <ul style="margin:4px 0 0;padding-left:20px;color:#7f1d1d">
          ${errors.map(e => `<li><strong>${esc(e.step)}</strong>: ${esc(e.error)}</li>`).join('')}
        </ul>
      </div>` : '';

  const warningsHtml = warnings.length
    ? `<div style="background:#fffbeb;border-left:3px solid #f59e0b;padding:8px 12px;margin:12px 0;font-size:13px">
        <strong>Warnings:</strong>
        ${bullets(warnings)}
      </div>` : '';

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#111;max-width:640px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 4px;font-size:20px">${esc(subjectIcon)} New brand provisioned</h2>
  <p style="color:#666;margin:0 0 16px">${esc(client.business_name || client.slug)} is live on the portal.</p>

  ${errorsHtml}
  ${warningsHtml}

  <h3 style="font-size:14px;margin:16px 0 4px;color:#111">Tenant</h3>
  <table style="font-size:13px;border-collapse:collapse;width:100%">
    <tr><td style="padding:3px 8px 3px 0;color:#555">Business</td><td>${esc(client.business_name)}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Slug</td><td><code>${esc(client.slug)}</code></td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Owner</td><td>${esc(client.owner_name || info?.owner_name || '—')} &lt;${esc(client.owner_email || info?.owner_email || '—')}&gt;</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Plan</td><td>${esc(client.plan_tier || client.plan || '—')}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Domain requested</td><td>${esc(info?.domain_preference || '—')}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Stripe Connect</td><td>${client.stripe_connected_account_id ? `linked (${esc(client.stripe_connected_account_id)})` : '<span style="color:#dc2626">not linked</span>'}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Platform fee</td><td>${esc(client.platform_fee_pct ?? 10)}%</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Brand colors</td><td>${esc(client.primary_color || info?.primary_color || '—')} / ${esc(client.secondary_color || info?.secondary_color || '—')}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Assets uploaded</td><td>${assetCount}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Services on file</td><td>${serviceCount}</td></tr>
    <tr><td style="padding:3px 8px 3px 0;color:#555">Keywords intake</td><td>${keywordCount} (+ platform: iSlay Studios, + auto)</td></tr>
  </table>

  <h3 style="font-size:14px;margin:20px 0 4px">Provisioning steps</h3>
  <ul style="margin:4px 0;padding-left:20px;font-size:13px">${completedHtml}</ul>

  <p style="margin-top:24px;font-size:13px">
    <a href="${portalUrl}" style="color:#0ea5e9;text-decoration:none;font-weight:600">Open in portal →</a>
    ${supabaseUrl ? ` · <a href="${supabaseUrl}" style="color:#888;font-size:12px">Supabase record</a>` : ''}
  </p>

  <hr style="border:none;border-top:1px solid #eee;margin:32px 0 12px">
  <p style="color:#888;font-size:11px">© 2026 GoElev8.ai · Provisioning agent</p>
</body></html>`;

  await sendMail({
    to: ADMIN_EMAIL,
    subject,
    html,
    text:
      `${subjectIcon} ${client.business_name || client.slug} provisioned\n\n` +
      `Slug: ${client.slug}\n` +
      `Owner: ${client.owner_name || info?.owner_name || '—'}\n` +
      `Plan: ${client.plan_tier || client.plan || '—'}\n` +
      `Domain: ${info?.domain_preference || '—'}\n` +
      `Stripe Connect: ${client.stripe_connected_account_id || 'NOT linked'}\n` +
      `Assets: ${assetCount} · Services: ${serviceCount} · Keywords: ${keywordCount}\n\n` +
      `Completed: ${completed.join(', ')}\n` +
      (errors.length ? `Errors: ${errors.map(e => e.step).join(', ')}\n` : '') +
      `\nPortal: ${portalUrl}\n`
  });
}
