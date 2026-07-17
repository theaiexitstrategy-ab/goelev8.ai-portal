// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Flow B — Free Flow Fitness studio billing to GoElev8.
//
// Model: $50/mo base + first 5 bookings/month free + $10 per booking
// after that. Applied per America/Chicago calendar month; the studio
// sees an invoice for the prior month on the 1st.
//
// Default counting policy: every accepted submission (any service_type)
// counts against the free quota. Reasoning: overage kicks in only after
// 5 submissions in a month, so a couple of drive-by inquiries won't
// tip a studio into billable territory. Aaron can flip this to
// paid-parties-only by narrowing the eligibility check in
// countBookingForBilling if that becomes the desired policy.

import { supabaseAdmin } from './supabase.js';

const BASE_FEE_CENTS   = 5000;   // $50
const FREE_QUOTA       = 5;
const OVERAGE_UNIT_CENTS = 1000; // $10 per booking after the free 5
const TENANT_SLUG      = 'freeflow_fitness_stl';

// Format a Date into 'YYYY-MM' in America/Chicago (the studio's TZ).
// Serverless functions run in UTC; without the TZ shift, a booking at
// midnight local on the 1st of a month gets counted against the
// PREVIOUS month's statement.
function currentPeriodChicago(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit'
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  return `${y}-${m}`;
}

// Count one booking toward the studio's monthly usage. Idempotent —
// bookings with billing_counted=true short-circuit so re-entry (double
// webhooks, retries) can't double-charge. Recomputes the statement
// row's totals from ground truth (SELECT COUNT) rather than +=1 so a
// race between two concurrent counts converges on the same numbers.
export async function countBookingForBilling(booking) {
  if (!booking?.id) return { ok: false, reason: 'no_booking_id' };
  if (booking.billing_counted) return { ok: true, skipped: 'already_counted' };

  const period = currentPeriodChicago();

  // Mark the booking as counted first + stamp its period. Use an
  // optimistic guard on billing_counted=false so exactly one concurrent
  // writer wins.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('freeflow_bookings')
    .update({ billing_counted: true, billing_period: period })
    .eq('id', booking.id)
    .eq('billing_counted', false)
    .select('id')
    .maybeSingle();
  if (claimErr) return { ok: false, error: claimErr.message };
  if (!claimed) return { ok: true, skipped: 'lost_race' };

  // Recount everything in the period from ground truth — no dependency
  // on the previous statement row's counter.
  const { count: totalBookings } = await supabaseAdmin
    .from('freeflow_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_slug', TENANT_SLUG)
    .eq('billing_period', period);

  const billable  = Math.max(0, (totalBookings || 0) - FREE_QUOTA);
  const overage   = billable * OVERAGE_UNIT_CENTS;
  const total     = BASE_FEE_CENTS + overage;

  // Upsert the open statement row. onConflict tenant_slug+period.
  const { error: upErr } = await supabaseAdmin
    .from('freeflow_billing_statements')
    .upsert({
      tenant_slug:       TENANT_SLUG,
      period,
      base_fee_cents:    BASE_FEE_CENTS,
      free_quota:        FREE_QUOTA,
      total_bookings:    totalBookings || 0,
      billable_bookings: billable,
      overage_cents:     overage,
      total_cents:       total,
      status:            'open'
    }, { onConflict: 'tenant_slug,period' });
  if (upErr) return { ok: false, error: upErr.message };

  return { ok: true, period, total_bookings: totalBookings, total_cents: total };
}

// Freeze a completed period. Called by the monthly cron on the 1st for
// the prior period, and manually via Master Admin if Aaron wants to
// close a month early. Idempotent — already-finalized rows are no-ops.
export async function finalizeMonth(period) {
  if (!period) throw new Error('period required');
  const { data, error } = await supabaseAdmin
    .from('freeflow_billing_statements')
    .update({ status: 'finalized', finalized_at: new Date().toISOString() })
    .eq('tenant_slug', TENANT_SLUG)
    .eq('period', period)
    .eq('status', 'open')
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// Previous-month period string in Chicago TZ — cron's default target.
export function priorPeriodChicago(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit'
  }).formatToParts(now);
  let y = parseInt(parts.find(p => p.type === 'year').value, 10);
  let m = parseInt(parts.find(p => p.type === 'month').value, 10) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export const FREEFLOW_TENANT_SLUG = TENANT_SLUG;
export const FREEFLOW_BASE_FEE_CENTS = BASE_FEE_CENTS;
export const FREEFLOW_FREE_QUOTA = FREE_QUOTA;
