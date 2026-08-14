// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Public event lookup for a tenant marketing site's event page.
//
// GET /api/external/events?slug=flex-facility&event_key=roq-n-flex-bootcamp
//   → { event: { title, when, where, pricing, seats_remaining,
//                waiver: { required, version, text } } }
//
// GET /api/external/events?slug=flex-facility
//   → { events: [ …every published event… ] }
//
// Unauthenticated on purpose: this is the same marketing copy the page
// already renders publicly, and requiring a key would push a credential
// into the browser for no gain. Only status='published' rows are ever
// returned, and nothing tenant-private (fee percentages, connected
// account ids, attendee data) is exposed — the response carries the
// customer-facing total, not the split behind it.
//
// WHY THE PAGE SHOULD CALL THIS rather than hardcoding: the waiver text
// lives here. When the attorney-reviewed release replaces the current
// copy, the operator edits the event row in the portal and every tenant
// page picks it up on next load — no tenant redeploy, and no window where
// the page is showing superseded copy. The page echoes the
// `waiver.version` it displayed back on the reservation call so the
// portal can reject a stale acceptance (409 waiver_version_stale).

import { resolveClientBySlug } from '../../lib/tenant-slug.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { quoteEventSeat, resolvePlatformFeePct } from '../../lib/platform-fee.js';
import { setPublicCors } from '../../lib/public-cors.js';

function shapeEvent(ev, client) {
  const pricing = quoteEventSeat({
    listPriceCents:           ev.price_cents,
    quantity:                 1,
    platformFeePct:           resolvePlatformFeePct({ platform_fee_pct: ev.platform_fee_pct ?? client.platform_fee_pct }),
    processingFeeCents:       ev.processing_fee_cents,
    passStripeFeesToCustomer: ev.pass_stripe_fees_to_customer
  });
  return {
    event_key:    ev.event_key,
    title:        ev.title,
    description:  ev.description,
    starts_at:    ev.starts_at,
    event_tz:     ev.event_tz,
    duration_min: ev.duration_min,
    location: {
      name:        ev.location_name,
      address1:    ev.address_line1,
      address2:    ev.address_line2,
      city:        ev.city,
      state:       ev.state,
      postal_code: ev.postal_code
    },
    // Customer-facing money only. The platform/tenant split stays server
    // side — the page needs to display a price, not our margin.
    pricing: {
      currency:             ev.currency || 'usd',
      list_price_cents:     pricing.subtotal_cents,
      processing_fee_cents: pricing.stripe_fee_cents + pricing.processing_fee_cents,
      total_cents:          pricing.customer_total_cents
    },
    capacity:        ev.capacity,
    seats_remaining: ev.capacity == null ? null : Math.max(0, ev.capacity - (ev.seats_reserved || 0)),
    sold_out:        ev.capacity != null && (ev.seats_reserved || 0) >= ev.capacity,
    waiver: {
      required: ev.waiver_required,
      version:  ev.waiver_version,
      text:     ev.waiver_text
    },
    image_url: ev.image_url
  };
}

export default async function handler(req, res) {
  setPublicCors(res, req.headers.origin, { methods: 'GET, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const slug     = String(url.searchParams.get('slug') || '').trim();
  const eventKey = String(url.searchParams.get('event_key') || '').trim();
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const { data: client, error: clientErr } = await resolveClientBySlug(
    slug, 'id, slug, name, platform_fee_pct');
  if (clientErr) return res.status(500).json({ error: clientErr.message });
  if (!client)   return res.status(404).json({ error: 'tenant_not_found' });

  let query = supabaseAdmin.from('tenant_events').select('*')
    .eq('client_id', client.id)
    .eq('status', 'published');
  if (eventKey) query = query.eq('event_key', eventKey);

  const { data: rows, error } = await query.order('starts_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });

  if (eventKey) {
    const ev = (rows || [])[0];
    if (!ev) return res.status(404).json({ error: 'event_not_found' });
    return res.status(200).json({ event: shapeEvent(ev, client) });
  }
  return res.status(200).json({ events: (rows || []).map(ev => shapeEvent(ev, client)) });
}
