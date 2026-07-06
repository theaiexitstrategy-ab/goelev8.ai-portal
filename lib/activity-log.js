// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Cross-product admin activity logger. Writes a single row per admin
// action to public.admin_activity_log in the PORTAL's own Supabase.
// Read side lives at /api/admin?action=admin-activity-log.
//
// SERVER-SIDE ONLY. Uses supabaseAdmin (service role) so RLS doesn't
// block writes from admin endpoints.
//
// Fire-and-forget shape: this helper NEVER throws — even if the log
// table doesn't exist yet or the insert fails for any other reason,
// the caller's happy path is unaffected. Log failures are console-
// warned so they show up in Vercel logs but don't break the action
// that was being logged.

import { supabaseAdmin } from './supabase.js';

// Log one admin action. All fields optional except `action` (a short
// stable slug like 'send_sms' or 'delete_participant'). Product slug
// tags the row to a specific product when known; leave null for
// portal-wide actions.
//
// Args:
//   action        — required, short slug (snake_case)
//   actor_email   — who did it. Usually ctx.user.email from requireAdmin.
//   product_slug  — the product this action belongs to (null for
//                   portal-wide actions). When the caller has a req,
//                   pass req.headers['x-product-slug'] when set.
//   target_type   — what kind of thing was touched: 'participant',
//                   'client', 'tenant', 'blast', etc.
//   target_id     — id of the target as a string (may be uuid, slug,
//                   phone number, etc. depending on target_type)
//   metadata      — freeform jsonb-safe object with extra context.
//                   Kept small — never dump the full row here.
export async function logAdminAction({
  action,
  actor_email = null,
  product_slug = null,
  target_type = null,
  target_id = null,
  metadata = null
} = {}) {
  if (!action || typeof action !== 'string') {
    console.warn('[activity-log] refused: action required (string)');
    return;
  }
  try {
    const row = {
      action:       action.slice(0, 80),
      actor_email:  actor_email || null,
      product_slug: product_slug || null,
      target_type:  target_type || null,
      target_id:    target_id != null ? String(target_id) : null,
      metadata:     metadata || null
    };
    const { error } = await supabaseAdmin.from('admin_activity_log').insert(row);
    if (error) {
      // Tolerant of "table does not exist" — before migration 0033 has
      // been applied on this env, log writes are silent no-ops so we
      // don't spam Vercel logs with the same error on every action.
      if (/relation .*admin_activity_log.* does not exist/i.test(error.message || '')) {
        // First warning only; subsequent ones would just be noise.
        if (!globalThis.__activityLogTableMissingWarned) {
          console.warn('[activity-log] admin_activity_log table not found — run Pending Migrations to apply 0033. Log writes are no-op until then.');
          globalThis.__activityLogTableMissingWarned = true;
        }
        return;
      }
      console.warn('[activity-log] insert failed:', error.message);
    }
  } catch (e) {
    console.warn('[activity-log] threw:', e.message);
  }
}

// Convenience wrapper for admin endpoints: extracts actor_email from
// ctx and product_slug from the x-product-slug header. Callers still
// pass action + optional target/metadata.
export async function logFromReq(req, ctx, opts = {}) {
  const headerSlug = String(req?.headers?.['x-product-slug'] || '').trim() || null;
  return logAdminAction({
    action:       opts.action,
    actor_email:  ctx?.user?.email || null,
    product_slug: opts.product_slug || headerSlug,
    target_type:  opts.target_type || null,
    target_id:    opts.target_id != null ? opts.target_id : null,
    metadata:     opts.metadata || null
  });
}
