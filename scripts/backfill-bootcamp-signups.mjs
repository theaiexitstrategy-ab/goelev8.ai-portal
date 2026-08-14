// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// One-time import of public.bootcamp_signups from the FLEX Supabase
// project into public.event_reservations on the PORTAL Supabase project.
// These are two separate databases, so this has to run as a script with a
// connection to each — there is no cross-project query.
//
// WHAT THIS ADDS OVER THE STRIPE SCAN
// -----------------------------------
// lib/event-ingest.js already mirrors every paid bootcamp session by
// reading the platform Stripe account, and that alone gets payments
// showing in the portal. But Stripe only knows what Checkout collected:
// name, email, amount. The phone number and the waiver_accepted flag live
// only in the FLEX table, because the marketing site's own form captured
// them. This script fills those two fields in on rows the Stripe scan
// already created, matched on stripe_session_id.
//
// It is therefore SAFE AND EXPECTED to run this after the Stripe scan.
// Rows that already exist get enriched, not duplicated.
//
// A NOTE ON WAIVER TEXT: bootcamp_signups stores waiver_accepted as a
// bare boolean and never stored the copy that was shown. Nothing can
// reconstruct that after the fact, so imported rows carry
// waiver_accepted + the event's waiver_version and a NULL waiver_text.
// Reservations taken through the portal snapshot the full text at
// acceptance. That asymmetry is permanent for the historical rows and is
// worth knowing before relying on them in a dispute.
//
// USAGE (credentials stay local — do NOT add the FLEX keys to Vercel):
//
//   FLEX_SUPABASE_URL=https://xxxx.supabase.co \
//   FLEX_SUPABASE_SERVICE_ROLE_KEY=eyJ… \
//   SUPABASE_URL=https://yyyy.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=eyJ… \
//   node scripts/backfill-bootcamp-signups.mjs --event-key roq-n-flex-bootcamp --slug flex-facility
//
//   Add --dry-run to print what would change without writing.

import { createClient } from '@supabase/supabase-js';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const DRY      = args.includes('--dry-run');
const SLUG     = flag('slug', 'flex-facility');
const EVENT_KEY = flag('event-key', 'roq-n-flex-bootcamp');

function need(name) {
  const v = process.env[name];
  if (!v) { console.error(`Missing env var: ${name}`); process.exit(1); }
  return v;
}

const flex = createClient(need('FLEX_SUPABASE_URL'), need('FLEX_SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false }
});
const portal = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Same normalization the portal uses on write, so a phone imported here
// matches one captured through the portal.
function toE164(phone) {
  if (!phone) return null;
  const raw = String(phone).trim();
  if (raw.startsWith('+')) {
    const d = raw.slice(1).replace(/\D/g, '');
    return d.length >= 7 && d.length <= 15 ? '+' + d : null;
  }
  const d = raw.replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length >= 11 && d.length <= 15) return '+' + d;
  return null;
}

async function main() {
  console.log(`[backfill] ${DRY ? 'DRY RUN — ' : ''}slug=${SLUG} event_key=${EVENT_KEY}`);

  const { data: client, error: cErr } = await portal
    .from('clients').select('id, slug').eq('slug', SLUG).maybeSingle();
  if (cErr || !client) { console.error('[backfill] portal client not found:', SLUG, cErr?.message); process.exit(1); }

  const { data: event, error: eErr } = await portal
    .from('tenant_events').select('id, waiver_version, price_cents')
    .eq('client_id', client.id).eq('event_key', EVENT_KEY).maybeSingle();
  if (eErr || !event) {
    console.error('[backfill] tenant_events row not found — run migration 0042 first.', eErr?.message);
    process.exit(1);
  }

  const { data: signups, error: sErr } = await flex
    .from('bootcamp_signups')
    .select('name, phone, email, waiver_accepted, stripe_session_id, payment_status, created_at')
    .order('created_at', { ascending: true });
  if (sErr) { console.error('[backfill] FLEX read failed:', sErr.message); process.exit(1); }

  console.log(`[backfill] ${signups?.length || 0} rows in bootcamp_signups`);
  const stats = { enriched: 0, inserted: 0, skipped: 0, errors: 0 };

  for (const s of signups || []) {
    const phone  = toE164(s.phone);
    const status = s.payment_status === 'paid' ? 'confirmed' : 'pending';

    // Did the Stripe scan already create this row?
    let existing = null;
    if (s.stripe_session_id) {
      const { data } = await portal.from('event_reservations')
        .select('id, attendee_phone, waiver_accepted')
        .eq('stripe_session_id', s.stripe_session_id).maybeSingle();
      existing = data;
    }

    if (existing) {
      // Enrich only the fields Stripe couldn't know. Never overwrite a
      // value already present — the portal's own capture is at least as
      // good as the mirror's.
      const patch = {};
      if (phone && !existing.attendee_phone) patch.attendee_phone = phone;
      if (s.waiver_accepted && !existing.waiver_accepted) {
        patch.waiver_accepted = true;
        patch.waiver_version  = event.waiver_version;
      }
      if (!Object.keys(patch).length) { stats.skipped++; continue; }
      if (DRY) { console.log('  would enrich', existing.id, patch); stats.enriched++; continue; }
      const { error } = await portal.from('event_reservations').update(patch).eq('id', existing.id);
      if (error) { console.error('  enrich failed', existing.id, error.message); stats.errors++; }
      else stats.enriched++;
      continue;
    }

    // No Stripe-side row — an abandoned or unpaid signup that never
    // produced a completed session. Still worth having: it's a lead.
    if (DRY) { console.log('  would insert', s.email || s.name, status); stats.inserted++; continue; }
    const { error } = await portal.rpc('reserve_event_seats', {
      p_event_id:           event.id,
      p_client_id:          client.id,
      p_quantity:           1,
      p_attendee_name:      s.name || 'Unknown',
      p_attendee_email:     s.email || null,
      p_attendee_phone:     phone,
      p_waiver_accepted:    !!s.waiver_accepted,
      p_waiver_version:     event.waiver_version,
      p_waiver_text:        null,   // never captured upstream — see header
      p_waiver_text_sha256: null,
      p_waiver_ip:          null,
      p_waiver_user_agent:  null,
      p_idempotency_key:    s.stripe_session_id ? 'flex-import:' + s.stripe_session_id : null,
      p_source:             'flex_bootcamp_import',
      p_source_url:         null,
      p_status:             status,
      p_stripe_session_id:  s.stripe_session_id || null,
      p_list_price_cents:   event.price_cents,
      p_amount_total_cents: null,
      p_platform_fee_cents: null,
      p_stripe_fee_cents:   null,
      p_application_fee_cents: null
    });
    if (error) { console.error('  insert failed', s.email || s.name, error.message); stats.errors++; }
    else stats.inserted++;
  }

  console.log('[backfill] done:', stats);
  if (stats.errors) process.exitCode = 1;
}

main().catch((e) => { console.error('[backfill] crashed:', e); process.exit(1); });
