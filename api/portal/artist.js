// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Artist inquiries + studio bookings API for iSlay Studios
// ?action=inquiries | bookings | book-session | pipeline | dashboard

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { sendArtistBookingSms } from '../../lib/islay-sms.js';

async function handleInquiries(req, res, ctx) {
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const status = url.searchParams.get('status');
    let q = supabaseAdmin.from('artist_inquiries').select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(500);
    if (status && status !== 'All') q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ inquiries: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { artist_name, artist_phone, artist_email, genre, service_interest, budget_range, source, notes } = body;
    if (!artist_name) return res.status(400).json({ error: 'artist_name_required' });
    const { data, error } = await supabaseAdmin.from('artist_inquiries').insert({
      client_id: clientId, artist_name, artist_phone, artist_email,
      genre, service_interest, budget_range, status: 'New',
      source: source || 'manual', notes
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ inquiry: data });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...patch } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });
    delete patch.client_id; delete patch.created_at;
    const { data, error } = await supabaseAdmin.from('artist_inquiries')
      .update(patch).eq('id', id).eq('client_id', clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ inquiry: data });
  }

  if (req.method === 'DELETE') {
    const { id } = await readJson(req);
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { error } = await supabaseAdmin.from('artist_inquiries')
      .delete().eq('id', id).eq('client_id', clientId);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleBookings(req, res, ctx) {
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const status = url.searchParams.get('status');
    const today = url.searchParams.get('today');
    let q = supabaseAdmin.from('studio_bookings')
      .select('*, artist_inquiries(artist_name, genre)')
      .eq('client_id', clientId)
      .order('session_date', { ascending: true });
    if (status) q = q.eq('status', status);
    if (today === 'true') {
      const start = new Date(); start.setHours(0,0,0,0);
      const end = new Date(); end.setHours(23,59,59,999);
      q = q.gte('session_date', start.toISOString()).lte('session_date', end.toISOString());
    }
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ bookings: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { artist_inquiry_id, artist_name, phone, email, service_type,
            session_date, duration_hours, rate_per_hour, notes } = body;
    if (!artist_name || !session_date) return res.status(400).json({ error: 'missing_fields' });
    const total_amount = (Number(duration_hours) || 1) * (Number(rate_per_hour) || 0);
    const { data, error } = await supabaseAdmin.from('studio_bookings').insert({
      client_id: clientId, artist_inquiry_id: artist_inquiry_id || null,
      artist_name, phone, email, service_type,
      session_date: new Date(session_date).toISOString(),
      duration_hours: Number(duration_hours) || 1,
      rate_per_hour: Number(rate_per_hour) || 0,
      total_amount, status: 'Confirmed', notes
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });

    // Update artist inquiry status to Booked if linked
    if (artist_inquiry_id) {
      await supabaseAdmin.from('artist_inquiries')
        .update({ status: 'Booked' })
        .eq('id', artist_inquiry_id).eq('client_id', clientId);
    }

    // Send booking confirmation SMS
    try {
      const { data: client } = await supabaseAdmin.from('clients')
        .select('*').eq('id', clientId).single();
      if (client && phone) {
        await sendArtistBookingSms({ client, booking: data });
      }
    } catch (e) { console.error('[artist/book] SMS failed:', e.message); }

    return res.status(201).json({ booking: data });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...patch } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });
    delete patch.client_id; delete patch.created_at;
    if (patch.duration_hours && patch.rate_per_hour) {
      patch.total_amount = Number(patch.duration_hours) * Number(patch.rate_per_hour);
    }
    const { data, error } = await supabaseAdmin.from('studio_bookings')
      .update(patch).eq('id', id).eq('client_id', clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ booking: data });
  }

  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handlePipeline(req, res, ctx) {
  const { clientId } = ctx;
  const STAGES = ['New', 'Contacted', 'Booked', 'In Studio', 'Converted', 'Lost'];
  const { data: inquiries, error } = await supabaseAdmin
    .from('artist_inquiries').select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const pipeline = {};
  for (const s of STAGES) {
    const items = (inquiries || []).filter(i => i.status === s);
    const value = items.reduce((sum, i) => {
      const budget = i.budget_range || '';
      const match = budget.match(/\d+/);
      return sum + (match ? parseInt(match[0], 10) : 0);
    }, 0);
    pipeline[s] = { count: items.length, value, items };
  }
  return res.status(200).json({ pipeline, stages: STAGES });
}

async function handleDashboard(req, res, ctx) {
  const { clientId } = ctx;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [inquiriesR, bookingsR, allInquiriesR] = await Promise.all([
    supabaseAdmin.from('artist_inquiries').select('id, status, created_at, budget_range')
      .eq('client_id', clientId).gte('created_at', monthStart),
    supabaseAdmin.from('studio_bookings')
      .select('id, total_amount, session_date, status, created_at, artist_name, service_type, duration_hours')
      .eq('client_id', clientId).gte('created_at', monthStart),
    supabaseAdmin.from('artist_inquiries').select('id, status, created_at')
      .eq('client_id', clientId)
  ]);

  const inquiries = inquiriesR.data || [];
  const bookings = bookingsR.data || [];
  const allInquiries = allInquiriesR.data || [];

  const newInquiries = inquiries.length;
  const sessionsBooked = bookings.filter(b =>
    ['Confirmed', 'Completed'].includes(b.status)).length;
  const conversions = inquiries.filter(i =>
    ['Booked', 'In Studio', 'Converted'].includes(i.status)).length;
  const revenue = bookings
    .filter(b => b.status !== 'Cancelled')
    .reduce((sum, b) => sum + (Number(b.total_amount) || 0), 0);

  // Average time from inquiry to booking (all time)
  let avgDaysToBook = null;
  const bookedInquiries = allInquiries.filter(i =>
    ['Booked', 'In Studio', 'Converted'].includes(i.status));
  if (bookedInquiries.length > 0) {
    // Rough estimate: days since created_at for booked inquiries
    const totalDays = bookedInquiries.reduce((sum, i) => {
      return sum + Math.max(1, Math.ceil((Date.now() - new Date(i.created_at).getTime()) / 86400000));
    }, 0);
    avgDaysToBook = Math.round(totalDays / bookedInquiries.length);
  }

  // Average session value
  const completedBookings = bookings.filter(b => b.status !== 'Cancelled');
  const avgSessionValue = completedBookings.length > 0
    ? completedBookings.reduce((sum, b) => sum + (Number(b.total_amount) || 0), 0) / completedBookings.length
    : 0;

  // Today's sessions
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
  const todaySessions = bookings.filter(b => {
    const d = new Date(b.session_date);
    return d >= todayStart && d <= todayEnd;
  });

  return res.status(200).json({
    stats: {
      new_inquiries: newInquiries,
      sessions_booked: sessionsBooked,
      conversions,
      revenue,
      conversion_rate: newInquiries > 0 ? ((conversions / newInquiries) * 100).toFixed(1) : '0.0',
      avg_days_to_book: avgDaysToBook,
      avg_session_value: avgSessionValue
    },
    today_sessions: todaySessions,
    recent_inquiries: inquiries.slice(0, 5)
  });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');
  if (action === 'inquiries')  return handleInquiries(req, res, ctx);
  if (action === 'bookings')   return handleBookings(req, res, ctx);
  if (action === 'pipeline')   return handlePipeline(req, res, ctx);
  if (action === 'dashboard')  return handleDashboard(req, res, ctx);
  return res.status(400).json({ error: 'unknown_action' });
}
