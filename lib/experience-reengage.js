// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Email re-engagement for experience tenants (first: Konquered Balance /
// konqueredkocktails.com). Drained by api/cron/experience-reengage.js.
//
// WHY EMAIL, AND WHY SEPARATE FROM NUDGES: lib/nudge-sms.js is SMS-only and
// hard-fails any tenant without a Twilio number, and Konquered Balance has no
// texting number yet. So its enquiries currently get no automated follow-up.
// This module sends email through the shared mailer instead. It never touches
// nudge_queue or the SMS path, so other tenants are unaffected.
//
// Two sequences, both driven off experience_bookings (the lifecycle row):
//
//   inquiry     status = 'lead' rows whose source is one of the tenant's
//               inquirySources (Ava's capture_lead tool: ava-voice / ava-chat).
//               Stephen gets an alert email per captured lead; the guest gets
//               a short series that stops the moment they convert.
//   post_event  status = 'confirmed' rows whose event has ended — thank-you +
//               review request, then gentle re-engagement for the next
//               gathering.
//
// STATE lives in leads.payload.reengage (payload is jsonb, migration 0030), so
// this ships with no migration. Shape:
//   { alerted_at, inquiry: { step, sending, last_sent_at, failures, stopped },
//     post_event: { ... same ... }, unsubscribed_at }
//
// DELIVERY is at-most-once: `sending` is written BEFORE the send. A crash
// mid-send leaves it set and the step is treated as sent, because a
// duplicate email to a guest is worse than a skipped one. A clean Resend
// failure clears it and retries on later runs, up to MAX_FAILURES.
//
// SUPPRESSION, checked before every send:
//   - the booking row moved on (deposit_pending / confirmed / cancelled)
//   - a newer booking for the same email is deposit_pending or confirmed
//   - lead.paid_at is set
//   - any lead in the tenant with that email is tagged Do Not Contact or
//     Email Unsubscribed (the unsubscribe link applies the latter)
//   - an earlier Ava lead for the same email in the last 30 days already owns
//     the sequence (Ava may save twice in one conversation)
//
// Steps that are overdue past their grace window are skipped rather than
// sent late, so an outage never fires a burst of stale emails.
//
// MAILER BLOCKED: a configuration failure (unverified sending domain, missing
// or invalid API key) fails every send, so it is not charged to any lead.
// The run stops at the first one and reports `blocked`, with no state
// changed, and resumes on its own once the configuration is fixed. Counting
// it as a per-lead failure would permanently stop every sequence within
// three runs.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { sendMail } from './mailer.js';

const HOUR = 3600_000;
const MAX_SENDS_PER_RUN = 20;
const MAX_FAILURES = 3;
const SUPPRESS_TAGS = ['Do Not Contact', 'Email Unsubscribed'];
export const UNSUBSCRIBED_TAG = 'Email Unsubscribed';

// ── Tenant config ──────────────────────────────────────────────────
// Copy and cadence live here. Brand rules for this tenant: never
// "bartending", "book now", "booking" or "buy"; keep capital-K styling.

const KB = {
  brand: 'Konquered Kocktails',
  site: 'https://konqueredkocktails.com',
  // Sender must be on a Resend-verified domain; replies go to the owner.
  from: process.env.KK_REENGAGE_FROM || 'Konquered Kocktails <noreply@goelev8.ai>',
  ownerEmailFallback: 'stephen@konqueredbalance.com',
  legalLine: 'Konquered Balance LLC, doing business as Konquered Kocktails · St. Charles, Missouri',
  // Nothing created before this is ever enrolled — no retroactive emails.
  launchAt: '2026-09-14T00:00:00Z',
  inquirySources: ['ava-voice', 'ava-chat'],
  postEventEnabled: true,
  defaultEventMinutes: 240,
};

export const TENANTS = { 'konquered-balance': KB };

// ── Email shell ────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (full) => String(full || '').trim().split(/\s+/)[0] || '';

function shell(cfg, { paragraphs, cta, unsubscribeUrl }) {
  const body = paragraphs.map((p) => Array.isArray(p)
    ? `<ul style="margin:0 0 18px;padding-left:20px;">${p.map((li) => `<li style="margin:0 0 8px;">${li}</li>`).join('')}</ul>`
    : `<p style="margin:0 0 18px;">${p}</p>`).join('');
  const button = cta
    ? `<p style="margin:26px 0 8px;"><a href="${cta.href}" style="display:inline-block;background:#C39A45;color:#151310;text-decoration:none;font-weight:600;font-size:13px;letter-spacing:1.2px;text-transform:uppercase;padding:13px 26px;border-radius:999px;">${cta.label}</a></p>`
    : '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#151310;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#151310;padding:36px 14px;">
<tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#123D35;border:1px solid rgba(195,154,69,0.35);border-radius:14px;">
<tr><td style="padding:34px 32px 8px;font-family:Georgia,'Times New Roman',serif;font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#C39A45;">${esc(cfg.brand)}</td></tr>
<tr><td style="padding:10px 32px 30px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15.5px;line-height:1.65;color:#E8D8B8;">
${body}${button}
<p style="margin:26px 0 0;font-family:Georgia,'Times New Roman',serif;font-style:italic;color:#C39A45;">Intention is the experience.</p>
</td></tr>
</table>
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
<tr><td style="padding:18px 12px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.6;color:#8a7f6c;text-align:center;">
You're receiving this because you reached out to ${esc(cfg.brand)}. Reply to this email to reach Stephen directly.<br/>
${esc(cfg.legalLine)}<br/>
<a href="${unsubscribeUrl}" style="color:#8a7f6c;">Unsubscribe from these emails</a>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

const signoff = 'With intention,<br/>Ava, Experience Concierge<br/>on behalf of Stephen Simmons, Founder';

// ── Sequences ──────────────────────────────────────────────────────
// afterHours counts from the lead's created_at (inquiry) or the event's end
// (post_event). graceHours is how late a step may still go out.

const INQUIRY_STEPS = [
  {
    // Wide grace: this is the note Ava promises, so it should survive a
    // mailer outage of a few days rather than be skipped.
    afterHours: 0, graceHours: 120,
    build: (cfg, { name, relationship }) => {
      const hi = `Hi ${esc(firstName(name)) || 'there'},`;
      if (relationship === 'past_client') {
        return {
          subject: `Thank you for coming back to ${cfg.brand}`,
          paragraphs: [
            hi,
            'It means a great deal to hear from you again. Your details are with Stephen, and he will reach out personally.',
            'If there is another gathering taking shape, he would love to begin with a complimentary 15-minute Experience Discovery, the same unhurried conversation as before.',
            `And if you haven't yet, we would be honored if you shared the story of your last experience with us at <a href="${cfg.site}/reviews" style="color:#C39A45;">${cfg.site.replace('https://', '')}/reviews</a>.`,
            signoff,
          ],
        };
      }
      return {
        subject: relationship === 'returning'
          ? `Welcome back to ${cfg.brand}`
          : `Thank you for thinking of ${cfg.brand}`,
        paragraphs: [
          hi,
          relationship === 'returning'
            ? 'It was lovely to reconnect. Your updated details are with Stephen Simmons, our founder and the artist behind every experience.'
            : 'Thank you for sharing the moment you are gathering for. Your details are with Stephen Simmons, our founder and the artist behind every experience.',
          'What happens next: Stephen will reach out to arrange a complimentary 15-minute Experience Discovery. It is a conversation, not a commitment. After it, he sends a custom proposal within 48 hours.',
          'A few things worth knowing now:',
          [
            'Our design process needs at least three weeks before your event.',
            'A date is reserved once the agreement is signed and the deposit is received.',
            'We accept a limited number of experiences each month.',
          ],
          'If anything comes to mind before then, simply reply to this email. It goes straight to Stephen.',
          signoff,
        ],
      };
    },
  },
  {
    afterHours: 48, graceHours: 48,
    build: (cfg, { name }) => ({
      subject: 'The feeling you want your guests to carry',
      paragraphs: [
        `Hi ${esc(firstName(name)) || 'there'},`,
        'As you think ahead to your gathering, here is the question every Konquered experience begins with: what would you love your guests to feel when they arrive, and when they leave?',
        'Stephen composes each experience from the answer: the people, the occasion, the light, the flavors. There is no set menu to choose from.',
        'If you have not found a time with Stephen yet, reply with a few days and times that suit you and he will make it work. If you have already spoken, thank you. There is no need to reply.',
        signoff,
      ],
    }),
  },
  {
    afterHours: 144, graceHours: 72,
    build: (cfg, { name }) => ({
      subject: 'An art gallery in a glass',
      paragraphs: [
        `Hi ${esc(firstName(name)) || 'there'},`,
        'Sometimes the best way to picture an experience is to see one. Our gallery holds the gatherings Stephen has composed: milestones, launches, and intimate evenings alike.',
        'Because each experience is designed from the ground up, we accept a limited number each month, and the design window is at least three weeks. If your date is approaching, now is a good moment to begin the conversation.',
      ],
      cta: { label: 'See the Work', href: `${cfg.site}/portfolio` },
    }),
  },
  {
    afterHours: 336, graceHours: 96,
    build: (cfg, { name }) => ({
      subject: "We'll keep the door open",
      paragraphs: [
        `Hi ${esc(firstName(name)) || 'there'},`,
        'Plans shift, guest lists change, and timing is not always right. That is completely understood.',
        'Whenever you are ready to create something meaningful, whether for this occasion or the next, simply reply to this email and Stephen will pick up where you left off.',
        'This is the last note in this series. Thank you for considering us.',
        signoff,
      ],
    }),
  },
];

const POST_EVENT_STEPS = [
  {
    afterHours: 24, graceHours: 120,
    build: (cfg, { name, experience }) => ({
      subject: 'Thank you for letting us be part of it',
      paragraphs: [
        `Hi ${esc(firstName(name)) || 'there'},`,
        `Thank you for inviting us into your gathering${experience ? ` for ${esc(experience)}` : ''}. Composing an experience around your people and your moment is exactly why we do this.`,
        'If you have a moment, we would be honored if you shared how it felt. A rating and a few sentences is plenty, and photos are welcome.',
        'And if anything could have been even better, simply reply. Stephen reads every note personally.',
      ],
      cta: { label: 'Share Your Story', href: `${cfg.site}/reviews` },
    }),
  },
  {
    afterHours: 21 * 24, graceHours: 10 * 24,
    build: (cfg, { name }) => ({
      subject: 'Keep the moment',
      paragraphs: [
        `Hi ${esc(firstName(name)) || 'there'},`,
        'A few weeks on, we hope your guests are still talking about it.',
        'If there was an expression you loved, Kustom Kocktail Development turns a moment into an original signature recipe, named and storied, for a milestone, a gift, or simply your own home.',
        'And if someone in your circle is planning a gathering of their own, we would be honored by the introduction. They can reach out to us directly.',
        signoff,
      ],
      cta: { label: 'Explore the Collection', href: `${cfg.site}/experiences` },
    }),
  },
  {
    afterHours: 75 * 24, graceHours: 21 * 24,
    build: (cfg, { name }) => ({
      subject: 'Your next gathering',
      paragraphs: [
        `Hi ${esc(firstName(name)) || 'there'},`,
        'Every season brings a new reason to gather: a milestone, a celebration, a moment worth honoring.',
        'Whenever the next one takes shape, reply to this email and Stephen will reach out personally to begin a complimentary Experience Discovery. As a returning client, you will never start from the beginning.',
        signoff,
      ],
      cta: { label: 'Begin the Conversation', href: `${cfg.site}/book` },
    }),
  },
];

// ── Unsubscribe tokens ─────────────────────────────────────────────

function signingSecret() {
  return process.env.REENGAGE_SIGNING_SECRET || process.env.CRON_SECRET || '';
}

export function unsubscribeToken(clientId, email) {
  const secret = signingSecret();
  if (!secret) return '';
  return createHmac('sha256', secret)
    .update(`${clientId}:${String(email).trim().toLowerCase()}`)
    .digest('base64url').slice(0, 32);
}

export function verifyUnsubscribeToken(clientId, email, token) {
  const expected = unsubscribeToken(clientId, email);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return Boolean(expected) && a.length === b.length && timingSafeEqual(a, b);
}

export function unsubscribeUrl(clientId, email) {
  const base = (process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai').replace(/\/$/, '');
  const e = Buffer.from(String(email).trim().toLowerCase()).toString('base64url');
  return `${base}/api/external/email-unsubscribe?c=${clientId}&e=${e}&t=${unsubscribeToken(clientId, email)}`;
}

/** Marks every lead in the tenant with this email as unsubscribed. */
export async function unsubscribeEmail(clientId, email) {
  const now = new Date().toISOString();
  const { data: leads, error } = await supabaseAdmin
    .from('leads').select('id, tags, payload')
    .eq('client_id', clientId).ilike('email', likeExact(email));
  if (error) throw new Error(error.message);
  for (const l of leads || []) {
    const tags = Array.from(new Set([...(l.tags || []), UNSUBSCRIBED_TAG]));
    const payload = { ...(l.payload || {}), reengage: { ...(l.payload?.reengage || {}), unsubscribed_at: now } };
    await supabaseAdmin.from('leads').update({ tags, payload }).eq('id', l.id);
  }
  return (leads || []).length;
}

// ── Helpers ────────────────────────────────────────────────────────

/** ilike pattern that matches the literal string, case-insensitively. */
function likeExact(s) {
  return String(s || '').trim().replace(/[\\%_]/g, (c) => `\\${c}`);
}

function relationshipOf(goal) {
  const g = String(goal || '');
  if (g.startsWith('Past client')) return 'past_client';
  if (g.startsWith('Returning inquiry')) return 'returning';
  return 'new';
}

async function emailSuppressed(clientId, email) {
  const { data } = await supabaseAdmin
    .from('leads').select('tags, payload')
    .eq('client_id', clientId).ilike('email', likeExact(email));
  return (data || []).some((l) =>
    (l.tags || []).some((t) => SUPPRESS_TAGS.includes(String(t))) || l.payload?.reengage?.unsubscribed_at);
}

async function saveState(lead, state, dry) {
  if (dry) return;
  const payload = { ...(lead.payload || {}), reengage: state };
  lead.payload = payload;
  const { error } = await supabaseAdmin.from('leads').update({ payload }).eq('id', lead.id);
  if (error) throw new Error(`state save failed: ${error.message}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BLOCKED_RE = /domain is not verified|RESEND_API_KEY|api key is invalid|missing api key|restricted_api_key/i;

class MailerBlocked extends Error {}

/** Rethrows configuration failures as MailerBlocked; returns the message otherwise. */
function classifySendError(e) {
  const msg = String(e?.message || e);
  if (BLOCKED_RE.test(msg)) throw new MailerBlocked(msg);
  return msg;
}

/**
 * Advance one sequence for one lead by at most one step.
 * Returns a short action string for the run summary.
 */
async function advance({ key, steps, baseTime, lead, state, ctx, stopReason, dry, now, budget }) {
  const seq = state[key] || { step: 0 };
  if (seq.stopped) return null;

  if (seq.sending != null) {
    // A previous run wrote `sending` and never finished: treat as sent.
    seq.step = seq.sending + 1; seq.sending = null;
  }

  const reason = await stopReason();
  if (reason) {
    seq.stopped = reason; seq.stopped_at = now.toISOString();
    state[key] = seq; await saveState(lead, state, dry);
    return `${key}:stopped:${reason}`;
  }

  const step = steps[seq.step];
  if (!step) {
    seq.stopped = 'complete'; seq.stopped_at = now.toISOString();
    state[key] = seq; await saveState(lead, state, dry);
    return `${key}:complete`;
  }

  const due = baseTime + step.afterHours * HOUR;
  if (now.getTime() < due) return null;
  if (now.getTime() > due + step.graceHours * HOUR) {
    (seq.skipped ||= []).push(seq.step + 1);
    seq.step += 1;
    state[key] = seq; await saveState(lead, state, dry);
    return `${key}:skipped_stale:${seq.step}`;
  }
  if (budget.sends >= MAX_SENDS_PER_RUN) return `${key}:deferred_budget`;

  const email = step.build(ctx.cfg, ctx);
  if (dry) return `${key}:would_send:${seq.step + 1}:${email.subject}`;

  seq.sending = seq.step;
  state[key] = seq; await saveState(lead, state, dry);
  budget.sends += 1;
  try {
    await sendMail({
      from: ctx.cfg.from,
      to: ctx.email,
      replyTo: ctx.ownerEmail,
      subject: email.subject,
      html: shell(ctx.cfg, { ...email, unsubscribeUrl: unsubscribeUrl(ctx.clientId, ctx.email) }),
    });
    seq.step += 1; seq.sending = null; seq.last_sent_at = new Date().toISOString(); seq.failures = 0;
    state[key] = seq; await saveState(lead, state, dry);
    await sleep(600); // stay under Resend's default 2 req/s
    return `${key}:sent:${seq.step}`;
  } catch (e) {
    seq.sending = null;
    let msg;
    try { msg = classifySendError(e); } catch (blocked) {
      state[key] = seq; await saveState(lead, state, dry);
      throw blocked;
    }
    seq.failures = (seq.failures || 0) + 1; seq.last_error = msg.slice(0, 300);
    if (seq.failures >= MAX_FAILURES) { seq.stopped = 'send_failed'; seq.stopped_at = new Date().toISOString(); }
    state[key] = seq; await saveState(lead, state, dry);
    return `${key}:send_error:${seq.last_error}`;
  }
}

async function alertOwner({ cfg, row, lead, ownerEmail, dry }) {
  if (dry) return 'alert:would_send';
  const rows = [
    ['Name', row.guest_name], ['Email', row.guest_email], ['Phone', row.guest_phone],
    ['Experience', row.experience_display], ['Details', row.goal],
    ['Channel', row.source === 'ava-chat' ? 'Text chat with Ava' : 'Call with Ava'],
  ].filter(([, v]) => v);
  const html = `<div style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1a1a;line-height:1.55;max-width:560px;">
<h2 style="margin:0 0 12px;">New inquiry captured by Ava</h2>
<table style="border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td style="padding:5px 14px 5px 0;color:#666;vertical-align:top;">${k}</td><td style="padding:5px 0;">${esc(v)}</td></tr>`).join('')}</table>
${row.source_url && row.source_url.includes('dashboard.vapi.ai') ? `<p><a href="${esc(row.source_url)}">Listen to the call →</a></p>` : ''}
<p style="margin-top:18px;">Email follow-up has started: the guest receives a thank-you now, then up to three gentle notes over two weeks. It stops on its own when they place a deposit or unsubscribe. To stop it yourself, tag the lead <strong>Do Not Contact</strong> in the portal.</p>
<p style="color:#888;font-size:12px;">Replies from the guest come straight to this inbox.</p></div>`;
  await sendMail({
    to: ownerEmail,
    subject: `[Ava] New inquiry: ${row.guest_name || row.guest_email}`,
    html,
    replyTo: row.guest_email || undefined,
  });
  return 'alert:sent';
}

// ── Runner ─────────────────────────────────────────────────────────

export async function runReengagement({ dry = false, now = new Date() } = {}) {
  if (process.env.REENGAGE_PAUSED === '1') return { ok: true, paused: true };
  const summary = { ok: true, dry, tenants: [] };
  const budget = { sends: 0 };

  try {
    await runTenants({ dry, now, summary, budget });
  } catch (e) {
    if (!(e instanceof MailerBlocked)) throw e;
    console.error('[experience-reengage] mailer blocked:', e.message);
    summary.ok = false;
    summary.blocked = e.message;
  }
  summary.sends = budget.sends;
  return summary;
}

async function runTenants({ dry, now, summary, budget }) {
  for (const [slug, cfg] of Object.entries(TENANTS)) {
    const t = { slug, inquiry_rows: 0, post_event_rows: 0, actions: [] };
    summary.tenants.push(t);

    const { data: client, error: cErr } = await supabaseAdmin
      .from('clients').select('id, owner_email').eq('slug', slug).maybeSingle();
    if (cErr || !client) { t.error = cErr?.message || 'tenant_not_found'; continue; }
    const ownerEmail = client.owner_email || cfg.ownerEmailFallback;
    const launch = new Date(cfg.launchAt).getTime();

    const loadLead = async (id) => {
      if (!id) return null;
      const { data } = await supabaseAdmin.from('leads')
        .select('id, name, email, tags, paid_at, payload').eq('id', id).maybeSingle();
      return data;
    };

    // Inquiries
    const since = new Date(Math.max(launch, now.getTime() - 30 * 24 * HOUR)).toISOString();
    const { data: inquiries, error: iErr } = await supabaseAdmin
      .from('experience_bookings').select('*')
      .eq('client_id', client.id).in('source', cfg.inquirySources)
      .gte('created_at', since).order('created_at', { ascending: true }).limit(200);
    if (iErr) { t.error = iErr.message; continue; }
    t.inquiry_rows = inquiries?.length || 0;

    for (const row of inquiries || []) {
      try {
        const lead = await loadLead(row.lead_id);
        if (!lead || !row.guest_email) { t.actions.push({ id: row.id, action: 'skipped:no_lead_or_email' }); continue; }
        const state = { ...(lead.payload?.reengage || {}) };
        const out = [];

        if (!state.alerted_at) {
          try {
            out.push(await alertOwner({ cfg, row, lead, ownerEmail, dry }));
            if (!dry) { state.alerted_at = new Date().toISOString(); await saveState(lead, state, dry); }
          } catch (e) { out.push(`alert:error:${classifySendError(e).slice(0, 200)}`); }
        }

        const created = new Date(row.created_at).getTime();
        const action = await advance({
          key: 'inquiry', steps: INQUIRY_STEPS, baseTime: created, lead, state, dry, now, budget,
          ctx: { cfg, clientId: client.id, ownerEmail, email: row.guest_email, name: row.guest_name, relationship: relationshipOf(row.goal) },
          stopReason: async () => {
            const { data: fresh } = await supabaseAdmin.from('experience_bookings').select('status').eq('id', row.id).maybeSingle();
            if (fresh && fresh.status !== 'lead') return fresh.status === 'cancelled' ? 'cancelled' : 'converted';
            if (lead.paid_at) return 'converted';
            if (await emailSuppressed(client.id, row.guest_email)) return 'unsubscribed_or_do_not_contact';
            const { data: others } = await supabaseAdmin.from('experience_bookings')
              .select('id, status, source, created_at')
              .eq('client_id', client.id).ilike('guest_email', likeExact(row.guest_email)).neq('id', row.id);
            for (const o of others || []) {
              const oc = new Date(o.created_at).getTime();
              if (['deposit_pending', 'confirmed'].includes(o.status) && oc >= created) return 'converted';
              if (cfg.inquirySources.includes(o.source) && oc < created && oc >= created - 30 * 24 * HOUR) return 'duplicate';
            }
            return null;
          },
        });
        if (action) out.push(action);
        if (out.length) t.actions.push({ id: row.id, action: out.join(' | ') });
      } catch (e) {
        if (e instanceof MailerBlocked) throw e;
        t.actions.push({ id: row.id, action: `error:${String(e?.message || e).slice(0, 200)}` });
      }
    }

    // Post-event
    if (!cfg.postEventEnabled) continue;
    const eventsFrom = new Date(Math.max(launch, now.getTime() - 100 * 24 * HOUR)).toISOString();
    const { data: events, error: eErr } = await supabaseAdmin
      .from('experience_bookings').select('*')
      .eq('client_id', client.id).eq('status', 'confirmed')
      .gte('event_starts_at', eventsFrom).lte('event_starts_at', now.toISOString())
      .order('event_starts_at', { ascending: true }).limit(200);
    if (eErr) { t.post_event_error = eErr.message; continue; }
    t.post_event_rows = events?.length || 0;

    for (const row of events || []) {
      try {
        const lead = await loadLead(row.lead_id);
        if (!lead || !row.guest_email) { t.actions.push({ id: row.id, action: 'post_event:skipped:no_lead_or_email' }); continue; }
        const state = { ...(lead.payload?.reengage || {}) };
        const ended = new Date(row.event_starts_at).getTime() + (row.duration_min || cfg.defaultEventMinutes) * 60_000;
        const action = await advance({
          key: 'post_event', steps: POST_EVENT_STEPS, baseTime: ended, lead, state, dry, now, budget,
          ctx: { cfg, clientId: client.id, ownerEmail, email: row.guest_email, name: row.guest_name, experience: row.experience_display },
          stopReason: async () => (await emailSuppressed(client.id, row.guest_email)) ? 'unsubscribed_or_do_not_contact' : null,
        });
        if (action) t.actions.push({ id: row.id, action });
      } catch (e) {
        if (e instanceof MailerBlocked) throw e;
        t.actions.push({ id: row.id, action: `post_event:error:${String(e?.message || e).slice(0, 200)}` });
      }
    }
  }
}
