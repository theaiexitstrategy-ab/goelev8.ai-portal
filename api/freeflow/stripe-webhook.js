// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Free Flow Fitness — Stripe webhook. Dedicated endpoint secret
// (STRIPE_FREEFLOW_WEBHOOK_SECRET) so it doesn't collide with the
// main GoElev8 webhook already registered in Stripe.
//
// Handles: checkout.session.completed with metadata.source ===
// 'freeflow' → flips freeflow_bookings.payment_status to
// 'deposit_paid' + booking_status to 'confirmed' + fires the
// "deposit paid" SMS. Idempotent (row already at 'deposit_paid' is a
// no-op).
//
// This route ALWAYS returns 200 to Stripe once the signature verifies
// so Stripe doesn't retry on our own downstream errors — those are
// logged for investigation. Signature-verify failures return 400.

import { supabaseAdmin } from '../../lib/supabase.js';
import { twilio } from '../../lib/twilio.js';
import { stripe } from '../../lib/stripe.js';

export const config = { api: { bodyParser: false } };

const OPT_OUT_REGEX = /\b(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|OPT[\s-]?OUT)\b/i;
const OPT_OUT_SUFFIX = '\n\nReply STOP to opt out.';

const DEPOSIT_PAID_TEMPLATE =
  "{first}, your {package} is LOCKED 🔥 Deposit received. We'll reach out to finalize your date + crew. Get ready to flow.";

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function composeSms(template, tokens) {
  let body = template;
  for (const [k, v] of Object.entries(tokens || {})) {
    body = body.replaceAll('{' + k + '}', v == null ? '' : String(v));
  }
  if (!OPT_OUT_REGEX.test(body)) body = body.trimEnd() + OPT_OUT_SUFFIX;
  return body;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  const secret = process.env.STRIPE_FREEFLOW_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[freeflow/stripe-webhook] STRIPE_FREEFLOW_WEBHOOK_SECRET not set');
    return res.status(500).end();
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, sig, secret);
  } catch (e) {
    console.error('[freeflow/stripe-webhook] signature verify failed:', e.message);
    return res.status(400).json({ error: 'signature_verification_failed' });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      if (session?.metadata?.source !== 'freeflow') {
        // Not one of ours — silently accept + move on.
        return res.status(200).json({ ok: true, ignored: 'not_freeflow' });
      }

      // Look up by stripe_session_id first; fall back to metadata.
      const sessionId = session.id;
      const bookingId = session?.metadata?.freeflow_booking_id;
      let booking;
      {
        const r = await supabaseAdmin.from('freeflow_bookings')
          .select('*').eq('stripe_session_id', sessionId).maybeSingle();
        booking = r.data;
      }
      if (!booking && bookingId) {
        const r = await supabaseAdmin.from('freeflow_bookings')
          .select('*').eq('id', bookingId).maybeSingle();
        booking = r.data;
      }
      if (!booking) {
        console.error('[freeflow/stripe-webhook] booking not found for session', sessionId);
        return res.status(200).json({ ok: true, warning: 'booking_not_found' });
      }

      // Idempotency: if we've already flipped this row, do nothing.
      if (booking.payment_status === 'deposit_paid') {
        return res.status(200).json({ ok: true, idempotent: true });
      }

      const { error: updErr } = await supabaseAdmin.from('freeflow_bookings')
        .update({
          payment_status: 'deposit_paid',
          booking_status: 'confirmed',
          updated_at:     new Date().toISOString()
        })
        .eq('id', booking.id);
      if (updErr) {
        console.error('[freeflow/stripe-webhook] booking update failed:', updErr.message);
        // Still return 200 so Stripe doesn't retry a DB error indefinitely.
        return res.status(200).json({ ok: false, warning: updErr.message });
      }

      // Deposit-paid SMS
      try {
        const from = process.env.TWILIO_MASTER_NUMBER || process.env.TWILIO_PHONE_NUMBER;
        if (from) {
          const smsBody = composeSms(DEPOSIT_PAID_TEMPLATE, {
            first:   booking.first_name,
            package: booking.package_name || booking.package_id || 'session'
          });
          await twilio.messages.create({
            from, to: booking.phone, body: smsBody,
            statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
          });
        }
      } catch (e) {
        console.error('[freeflow/stripe-webhook] deposit-paid SMS failed:', e.message);
      }

      return res.status(200).json({ ok: true, booking_id: booking.id });
    }

    // Any other event type — accept, no-op.
    return res.status(200).json({ ok: true, ignored: event.type });
  } catch (e) {
    console.error('[freeflow/stripe-webhook] handler crashed:', e.message);
    return res.status(200).json({ ok: false, warning: e.message });
  }
}
