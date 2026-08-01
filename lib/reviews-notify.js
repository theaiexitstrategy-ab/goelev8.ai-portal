// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Fires a new-review alert to the tenant owner. Matches the shape of
// lib/experience-notify.js — push to the tenant's client_users +
// admins, plus email to clients.owner_email and SMS to
// clients.owner_phone when populated. All channels are best-effort;
// a failure on one never blocks the others.
//
// Called from /api/cron/reviews-notify.js for each row where
// reviews.tenant_alert_sent_at IS NULL. The caller stamps
// tenant_alert_sent_at AFTER we return (so a partial failure gets
// re-tried on the next cron tick), but we do NOT retry indefinitely
// — the cron loop caps how many rows it processes per run.

import { supabaseAdmin } from './supabase.js';
import { twilio, twilioForClient, truncateForSms } from './twilio.js';
import { sendMail } from './mailer.js';
import { sendPushToClient, sendPushToAdmins } from './push.js';

function starsLine(rating) {
  const n = Number(rating);
  if (!Number.isFinite(n) || n < 1 || n > 5) return '';
  return '★'.repeat(Math.floor(n)) + '☆'.repeat(5 - Math.floor(n));
}

function truncateForPreview(text, max = 180) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

export async function notifyReviewArrived({ review }) {
  if (!review?.id || !review?.client_id) return { ok: false, error: 'invalid_review' };

  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('id, slug, name, business_name, owner_email, owner_phone, twilio_phone_number')
    .eq('id', review.client_id)
    .maybeSingle();
  if (!client) return { ok: false, error: 'tenant_not_found' };

  const bizName   = client.business_name || client.name || 'your business';
  const stars     = starsLine(review.rating);
  const preview   = truncateForPreview(review.review_text, 180);
  const guestName = (review.guest_name || 'Guest').trim();
  const eventType = review.event_type ? ` · ${review.event_type}` : '';

  const results = { push_client: null, push_admin: null, email: null, sms: null };

  // ── Push ────────────────────────────────────────────────────────
  const pushTitle = `⭐ New review from ${guestName}`;
  const pushBody  = [stars, eventType.replace(' · ', ''), preview].filter(Boolean).join(' · ').slice(0, 200);
  const pushUrl   = '/?tab=reviews';
  try { await sendPushToClient(client.id, pushTitle, pushBody, pushUrl); results.push_client = 'sent'; }
  catch (e) { results.push_client = 'error:' + (e?.message || e); }
  try { await sendPushToAdmins(`[${bizName}] ` + pushTitle, pushBody, pushUrl); results.push_admin = 'sent'; }
  catch (e) { results.push_admin = 'error:' + (e?.message || e); }

  // ── Email ───────────────────────────────────────────────────────
  if (client.owner_email) {
    try {
      const subject = `[${bizName}] New review from ${guestName}${stars ? ' — ' + stars : ''}`;
      const html = `
        <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.5;">
          <h2 style="margin:0 0 12px;">New review awaiting your review</h2>
          <table style="border-collapse:collapse;margin-bottom:14px;">
            <tr><td style="padding:4px 12px 4px 0;color:#666;">Rating</td><td style="padding:4px 0;"><strong style="font-size:1.1rem">${stars || (review.rating + '/5')}</strong></td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;">Guest</td><td style="padding:4px 0;"><strong>${guestName}</strong>${review.contact_ok ? ' <span style="font-size:0.75rem;padding:1px 6px;background:#dcfce7;color:#166534;border-radius:8px;margin-left:6px">✓ ok to contact</span>' : ''}</td></tr>
            ${review.event_type ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Event</td><td style="padding:4px 0;">${review.event_type}</td></tr>` : ''}
            ${review.email ? `<tr><td style="padding:4px 12px 4px 0;color:#666;">Email</td><td style="padding:4px 0;"><a href="mailto:${review.email}">${review.email}</a></td></tr>` : ''}
          </table>
          <div style="padding:12px 14px;background:#f9fafb;border-left:3px solid #d1d5db;border-radius:4px;font-style:italic;white-space:pre-wrap;">${(review.review_text || '').replace(/</g, '&lt;')}</div>
          ${(Array.isArray(review.photos) && review.photos.length) ? `<p style="margin-top:12px;font-size:0.9rem;color:#666;">${review.photos.length} photo${review.photos.length === 1 ? '' : 's'} attached — visible in portal.</p>` : ''}
          <p style="margin-top:20px;"><a href="https://portal.goelev8.ai/?tab=reviews" style="display:inline-block;padding:10px 18px;background:#0f172a;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Review in portal →</a></p>
          <p style="color:#888;font-size:12px;margin-top:22px;">Reviews stay unpublished until you approve them. This is sent by ${bizName} via GoElev8.ai.</p>
        </div>`;
      await sendMail({ to: client.owner_email, subject, html });
      results.email = 'sent';
    } catch (e) { results.email = 'error:' + (e?.message || e); }
  }

  // ── SMS ─────────────────────────────────────────────────────────
  if (client.owner_phone) {
    try {
      const from = client.twilio_phone_number || process.env.TWILIO_DEFAULT_FROM || process.env.TWILIO_MASTER_NUMBER || process.env.TWILIO_PHONE_NUMBER;
      if (from) {
        // Use master account for outbound to owner (owner is NOT the
        // tenant's own customer list — same pattern as experience-notify).
        const body = truncateForSms(
          `New ${stars || (review.rating + '/5')} review from ${guestName}${eventType}: "${truncateForPreview(review.review_text, 60)}" — review at portal.goelev8.ai`
        );
        await twilio.messages.create({ from, to: client.owner_phone, body });
        results.sms = 'sent';
      } else {
        results.sms = 'skipped_no_from';
      }
    } catch (e) { results.sms = 'error:' + (e?.message || e); }
  }

  return { ok: true, results };
}
