// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Sync sales from a client's own Stripe account into the portal sales table.
// POST /api/portal/sync-sales
//
// Fetches recent checkout sessions (last 90 days) from the client's Stripe
// secret key and upserts them into the sales table. Skips duplicates via
// stripe_session_id unique constraint.

import Stripe from 'stripe';
import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  // Get the client's own Stripe key
  const { data: client, error: clientErr } = await supabaseAdmin
    .from('clients').select('stripe_secret_key, name').eq('id', clientId).maybeSingle();
  if (clientErr && /column .*stripe_secret_key.* does not exist/i.test(clientErr.message)) {
    return res.status(400).json({
      error: 'migration_required',
      message: 'Run migration 0020 in Supabase: ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS stripe_secret_key text;'
    });
  }
  if (!client?.stripe_secret_key) {
    return res.status(400).json({
      error: 'no_stripe_key',
      message: 'No Stripe secret key configured for this client. Set it in Master Admin → Stripe field.'
    });
  }

  const clientStripe = new Stripe(client.stripe_secret_key, { apiVersion: '2024-06-20' });

  try {
    // Fetch completed checkout sessions from the last 90 days
    const ninetyDaysAgo = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
    const sessions = [];
    let hasMore = true;
    let startingAfter = undefined;

    while (hasMore && sessions.length < 500) {
      const params = {
        limit: 100,
        status: 'complete',
        created: { gte: ninetyDaysAgo }
      };
      if (startingAfter) params.starting_after = startingAfter;

      const page = await clientStripe.checkout.sessions.list(params);
      sessions.push(...page.data);
      hasMore = page.has_more;
      if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
    }

    // Also fetch charges for payments not via Checkout (direct charges, payment links)
    const charges = [];
    hasMore = true;
    startingAfter = undefined;

    while (hasMore && charges.length < 500) {
      const params = {
        limit: 100,
        created: { gte: ninetyDaysAgo }
      };
      if (startingAfter) params.starting_after = startingAfter;

      const page = await clientStripe.charges.list(params);
      charges.push(...page.data.filter(c => c.paid && c.status === 'succeeded'));
      hasMore = page.has_more;
      if (page.data.length) startingAfter = page.data[page.data.length - 1].id;
    }

    let created = 0;
    let skipped = 0;
    const errors = [];

    // Insert checkout sessions
    for (const s of sessions) {
      if (!s.amount_total || s.amount_total <= 0) { skipped++; continue; }
      const row = {
        client_id: clientId,
        stripe_session_id: s.id,
        amount: s.amount_total / 100,
        currency: s.currency || 'usd',
        customer_name: s.customer_details?.name || null,
        customer_email: s.customer_details?.email || null,
        customer_phone: s.customer_details?.phone || null,
        payment_status: 'paid',
        source: 'stripe_sync',
        created_at: new Date(s.created * 1000).toISOString()
      };
      const { error } = await supabaseAdmin.from('sales').upsert(row, {
        onConflict: 'stripe_session_id',
        ignoreDuplicates: true
      });
      if (error) {
        if (error.code === '23505') skipped++; // duplicate
        else errors.push({ id: s.id, message: error.message });
      } else {
        created++;
      }
    }

    // Insert direct charges (use charge ID as stripe_session_id for dedup)
    for (const c of charges) {
      // Skip if this charge is already covered by a checkout session
      if (sessions.some(s => s.payment_intent === c.payment_intent)) { skipped++; continue; }

      const row = {
        client_id: clientId,
        stripe_session_id: `ch_${c.id}`,
        amount: c.amount / 100,
        currency: c.currency || 'usd',
        customer_name: c.billing_details?.name || null,
        customer_email: c.billing_details?.email || c.receipt_email || null,
        customer_phone: c.billing_details?.phone || null,
        payment_status: 'paid',
        source: 'stripe_sync',
        created_at: new Date(c.created * 1000).toISOString()
      };
      const { error } = await supabaseAdmin.from('sales').upsert(row, {
        onConflict: 'stripe_session_id',
        ignoreDuplicates: true
      });
      if (error) {
        if (error.code === '23505') skipped++;
        else errors.push({ id: c.id, message: error.message });
      } else {
        created++;
      }
    }

    return res.status(200).json({
      synced: created,
      skipped,
      errors: errors.length,
      total_fetched: sessions.length + charges.length,
      error_details: errors.slice(0, 5)
    });
  } catch (e) {
    return res.status(500).json({
      error: 'stripe_sync_failed',
      message: e.message
    });
  }
}
