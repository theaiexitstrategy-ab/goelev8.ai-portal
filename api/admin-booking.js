// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Admin endpoint for book.goelev8.ai management.
// All actions require platform admin JWT.
//
// Actions:
//   dashboard        GET   — summary stats (tenants, bookings, recent signups)
//   tenants          GET   — all tenants with booking counts
//   tenant-detail    GET   ?slug=<slug> — single tenant + recent bookings
//   bookings         GET   ?slug=<slug>&status=<status> — filtered bookings
//   delete-tenant    POST  { slug }

import { requireAdmin, methodGuard, readJson } from '../lib/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

async function dashboard(req, res) {
  const [tenantsRes, bookingsRes, recentTenantsRes, recentBookingsRes, todayBookingsRes] = await Promise.all([
    supabaseAdmin.from('tenants').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('goelev8_bookings').select('id', { count: 'exact', head: true }),
    supabaseAdmin.from('tenants').select('slug, business_name, brand_color, plan, created_at').order('created_at', { ascending: false }).limit(10),
    supabaseAdmin.from('goelev8_bookings').select('id, tenant_slug, client_name, service, booking_date, booking_time, status, created_at').order('created_at', { ascending: false }).limit(15),
    supabaseAdmin.from('goelev8_bookings').select('id', { count: 'exact', head: true }).eq('booking_date', new Date().toISOString().slice(0, 10)),
  ]);

  // Bookings in last 7 days
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const { count: bookings_7d } = await supabaseAdmin
    .from('goelev8_bookings').select('id', { count: 'exact', head: true })
    .gte('created_at', weekAgo);

  // Tenants in last 30 days
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const { count: new_tenants_30d } = await supabaseAdmin
    .from('tenants').select('id', { count: 'exact', head: true })
    .gte('created_at', monthAgo);

  return res.status(200).json({
    total_tenants: tenantsRes.count || 0,
    total_bookings: bookingsRes.count || 0,
    bookings_today: todayBookingsRes.count || 0,
    bookings_7d: bookings_7d || 0,
    new_tenants_30d: new_tenants_30d || 0,
    recent_tenants: recentTenantsRes.data || [],
    recent_bookings: recentBookingsRes.data || [],
  });
}

async function tenants(req, res) {
  const { data: allTenants, error } = await supabaseAdmin
    .from('tenants')
    .select('id, slug, business_name, owner_email, owner_phone, brand_color, plan, staff_count, payment_preference, services, availability, stripe_customer_id, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  // Count bookings per tenant
  const slugs = allTenants.map(t => t.slug);
  const bookingCounts = {};
  if (slugs.length) {
    const { data: rows } = await supabaseAdmin
      .from('goelev8_bookings')
      .select('tenant_slug')
      .in('tenant_slug', slugs);
    for (const r of rows || []) bookingCounts[r.tenant_slug] = (bookingCounts[r.tenant_slug] || 0) + 1;
  }

  return res.status(200).json({
    tenants: allTenants.map(t => ({
      ...t,
      booking_count: bookingCounts[t.slug] || 0,
      service_count: Array.isArray(t.services) ? t.services.length : 0,
    })),
  });
}

async function tenantDetail(req, res) {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('slug');
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const { data: tenant } = await supabaseAdmin
    .from('tenants')
    .select('*')
    .eq('slug', slug)
    .single();

  if (!tenant) return res.status(404).json({ error: 'tenant not found' });

  const { data: bookings } = await supabaseAdmin
    .from('goelev8_bookings')
    .select('*')
    .eq('tenant_slug', slug)
    .order('created_at', { ascending: false })
    .limit(50);

  return res.status(200).json({ tenant, bookings: bookings || [] });
}

async function bookings(req, res) {
  const url = new URL(req.url, 'http://x');
  const slug = url.searchParams.get('slug');
  const status = url.searchParams.get('status');

  let q = supabaseAdmin
    .from('goelev8_bookings')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (slug) q = q.eq('tenant_slug', slug);
  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ bookings: data || [] });
}

async function deleteTenant(req, res) {
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const slug = body?.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  // Delete bookings first (FK constraint)
  await supabaseAdmin.from('goelev8_bookings').delete().eq('tenant_slug', slug);
  const { error } = await supabaseAdmin.from('tenants').delete().eq('slug', slug);
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');

  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireAdmin(req, res); if (!ctx) return;

  try {
    switch (action) {
      case 'dashboard':      return await dashboard(req, res);
      case 'tenants':        return await tenants(req, res);
      case 'tenant-detail':  return await tenantDetail(req, res);
      case 'bookings':       return await bookings(req, res);
      case 'delete-tenant':  return await deleteTenant(req, res);
      default:               return res.status(400).json({ error: 'unknown_action' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message || 'internal_error' });
  }
}
