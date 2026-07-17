// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Free Flow Fitness — booking intake. Called by the separate
// free-fitness-flow funnel repo (and by the Vapi assistant's
// tool-call). Adapted from the source prompt's TASK 2 to this repo's
// conventions: vanilla-JS Vercel serverless funcs, lib/supabase.js
// service-role client, lib/twilio.js SDK send, lib/stripe.js lazy
// singleton, no Next.js middleware (each route handles its own auth).
//
// Auth: x-goelev8-secret header must equal GOELEV8_WEBHOOK_SECRET.
// Rejecting non-matching + missing with 401.
//
// SECURITY: deposit_cents is DERIVED SERVER-SIDE from a package map;
// the funnel's body value is discarded. Guards against a caller
// tampering the amount to pay $0 or bypass a package.
//
// Confirmation SMS goes inline (await) so it lands <60s per source
// spec. From-number = TWILIO_MASTER_NUMBER (or falls back to
// TWILIO_PHONE_NUMBER — this repo's older env-var name). Opt-out
// notice is appended unless the body already contains a STOP/
// UNSUBSCRIBE/etc. token, mirroring the blast-compliance regex.

import { supabaseAdmin } from '../../lib/supabase.js';
import { twilio } from '../../lib/twilio.js';
import { stripe } from '../../lib/stripe.js';
import { toE164 } from '../../lib/phone.js';
import { countBookingForBilling } from '../../lib/freeflow-billing.js';

// Server-side authoritative deposit map. See TASK 2 in the source
// prompt — private_lesson always null; body-painting inquiry-only.
const PACKAGE_DEPOSIT_CENTS = {
  'fab-flow':       15000,   // $150
  'ultimate-flow':  20000,   // $200
  'private-group':  11250,   // $112.50
  'body-painting':  null,    // inquiry-only
};

const OPT_OUT_REGEX = /\b(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|OPT[\s-]?OUT)\b/i;
const OPT_OUT_SUFFIX = '\n\nReply STOP to opt out.';

// Compose SMS body from a template + tokens. {first} + {package} +
// {deposit}. Auto-appends STOP disclosure unless the body already
// contains it.
function composeSms(template, tokens) {
  let body = template;
  for (const [k, v] of Object.entries(tokens || {})) {
    body = body.replaceAll('{' + k + '}', v == null ? '' : String(v));
  }
  if (!OPT_OUT_REGEX.test(body)) body = body.trimEnd() + OPT_OUT_SUFFIX;
  return body;
}

// Templates carried verbatim from the source prompt. Studio voice:
// confident, warm, a little playful. Kept short — one SMS segment
// after opt-out suffix.
const SMS_TEMPLATES = {
  party_request_received:
    "Hey {first}! 💥 Your {package} request at Free Flow Fitness is in. Next up: your {deposit} deposit to lock the date — check your texts/email for the link. Then come shake your favorite ASSet.",
  party_inquiry_received:
    "Hey {first}! Got your Body Painting request at Free Flow Fitness 🎨 We'll text you to confirm your date + details. Get ready to make a mess (the fun kind).",
  private_lesson_received:
    "Hey {first}! Got your private lesson request at Free Flow Fitness. An instructor will reach out to set your time + goals — no group, no pressure, all you."
};

function pickTemplate({ service_type, deposit_cents }) {
  if (service_type === 'private_lesson') return 'private_lesson_received';
  if (deposit_cents == null)             return 'party_inquiry_received';
  return 'party_request_received';
}

function formatUsd(cents) {
  if (cents == null) return '';
  return '$' + (cents / 100).toFixed(2).replace(/\.00$/, '');
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end',  () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  // Auth
  const providedSecret = req.headers['x-goelev8-secret'] || req.headers['X-Goelev8-Secret'];
  if (!process.env.GOELEV8_WEBHOOK_SECRET
      || providedSecret !== process.env.GOELEV8_WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ ok: false, error: 'invalid_json' }); }

  const {
    service_type, package: packageId, package_name,
    first_name, last_name, email, phone, sms_consent,
    preferred_date, preferred_time, guest_count, occasion, dance_style,
    preferred_times, goals, experience_level, notes,
    lead_source, site_url
  } = body || {};

  // Validation
  if (!['party', 'private_lesson'].includes(service_type)) {
    return res.status(400).json({ ok: false, error: 'invalid_service_type' });
  }
  if (!first_name || !last_name) return res.status(400).json({ ok: false, error: 'name_required' });
  if (!email || !/^\S+@\S+\.\S+$/.test(String(email))) {
    return res.status(400).json({ ok: false, error: 'valid_email_required' });
  }
  const rawPhone = String(phone || '').trim();
  if (rawPhone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ ok: false, error: 'phone_required' });
  }
  if (sms_consent !== true) {
    return res.status(400).json({ ok: false, error: 'sms_consent_required' });
  }
  const e164 = toE164(rawPhone);
  if (!e164) return res.status(400).json({ ok: false, error: 'phone_e164_normalization_failed' });

  // Server-authoritative deposit derivation
  let depositCents = null;
  if (service_type === 'party' && packageId && packageId in PACKAGE_DEPOSIT_CENTS) {
    depositCents = PACKAGE_DEPOSIT_CENTS[packageId];
  }

  // Insert booking
  const insertRow = {
    tenant_slug:       'freeflow_fitness_stl',
    service_type,
    package_id:        packageId || null,
    package_name:      package_name || null,
    first_name, last_name, email,
    phone:             e164,
    sms_consent:       true,
    preferred_date:    preferred_date || null,
    preferred_time:    preferred_time || null,
    guest_count:       Number.isFinite(+guest_count) ? +guest_count : null,
    occasion:          occasion || null,
    dance_style:       dance_style || null,
    preferred_times:   preferred_times || null,
    goals:             goals || null,
    experience_level:  experience_level || null,
    notes:             notes || null,
    deposit_cents:     depositCents,
    payment_status:    depositCents != null ? 'deposit_pending' : 'none',
    booking_status:    'new_request',
    lead_source:       lead_source || 'freeflow_funnel'
  };
  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('freeflow_bookings').insert(insertRow).select().single();
  if (insErr) {
    console.error('[freeflow/bookings] insert failed:', insErr.message);
    return res.status(500).json({ ok: false, error: 'insert_failed', detail: insErr.message });
  }

  // Stripe Checkout Session — only when a deposit is due.
  let checkoutUrl = null;
  if (depositCents != null) {
    try {
      const successBase = String(site_url || '').replace(/\/+$/, '') || 'https://freeflowfitness.com';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        line_items: [{
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: depositCents,
            product_data: {
              name: `${package_name || packageId} — Deposit`,
              description: 'Deposit to reserve your Free Flow Fitness party. Balance due at your party.'
            }
          }
        }],
        metadata: {
          source: 'freeflow',
          freeflow_booking_id: inserted.id,
          tenant_slug: 'freeflow_fitness_stl',
          package_id: packageId || ''
        },
        success_url: `${successBase}/?booking=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url:  `${successBase}/?booking=cancelled`
      });
      checkoutUrl = session.url;
      await supabaseAdmin.from('freeflow_bookings')
        .update({ stripe_session_id: session.id })
        .eq('id', inserted.id);
    } catch (e) {
      // Don't 500 the whole intake on a Stripe hiccup — the booking
      // row + SMS still land, Aaron can chase down payment manually
      // from the JSON error field.
      console.error('[freeflow/bookings] stripe session failed:', e.message);
    }
  }

  // Confirmation SMS — inline. Send failures are logged but never
  // 500 the request (per source prompt step 6).
  try {
    const template = SMS_TEMPLATES[pickTemplate({ service_type, deposit_cents: depositCents })];
    const smsBody = composeSms(template, {
      first: first_name,
      package: package_name || packageId || 'your session',
      deposit: formatUsd(depositCents)
    });
    const from = process.env.TWILIO_MASTER_NUMBER || process.env.TWILIO_PHONE_NUMBER;
    if (from) {
      await twilio.messages.create({
        from, to: e164, body: smsBody,
        statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
      });
      await supabaseAdmin.from('freeflow_bookings')
        .update({ confirmation_sms_sent: true })
        .eq('id', inserted.id);
    } else {
      console.warn('[freeflow/bookings] no TWILIO_MASTER_NUMBER / TWILIO_PHONE_NUMBER set — SMS skipped');
    }
  } catch (e) {
    console.error('[freeflow/bookings] confirmation SMS failed:', e.message);
  }

  // Flow B metering. Best-effort; billing errors do not fail the
  // request either.
  try { await countBookingForBilling(inserted); }
  catch (e) { console.error('[freeflow/bookings] billing count failed:', e.message); }

  return res.status(200).json({
    ok: true,
    bookingId: inserted.id,
    checkoutUrl
  });
}
