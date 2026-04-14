// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Portal endpoint for goelev8_bookings (book.goelev8.ai) data.
// Returns bookings and tenant info for the current client.
//
// GET /api/portal/goelev8-bookings
//   Returns { tenant, bookings } for the authed client's linked tenant.
//   Returns { tenant: null } if the client has no linked tenant.

import { requireUser, methodGuard } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET'])) return;
  const ctx = await requireUser(req, res);
  if (!ctx) return;

  try {
    // Find tenant linked to this client
    const { data: tenant } = await supabaseAdmin
      .from('tenants')
      .select('slug, business_name, brand_color, custom_domain, services, availability, booking_url, created_at')
      .eq('client_id', ctx.clientId)
      .single();

    if (!tenant) {
      return res.status(200).json({ tenant: null, bookings: [] });
    }

    // Get all bookings for this tenant
    const { data: bookings } = await supabaseAdmin
      .from('goelev8_bookings')
      .select('*')
      .eq('tenant_slug', tenant.slug)
      .order('created_at', { ascending: false })
      .limit(200);

    return res.status(200).json({
      tenant,
      bookings: bookings || [],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
