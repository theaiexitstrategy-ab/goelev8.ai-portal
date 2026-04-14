// Consolidated CRM endpoint: contacts + bookings + leads + vapi_calls.
// ?action=contacts | bookings | leads | vapi_calls
// Replaces the legacy /api/portal/contacts and /api/portal/bookings routes
// to stay under the Vercel 12-function cap while we add /api/admin.

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';

async function handleContacts(req, res, ctx) {
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('contacts').select('*').eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contacts: data });
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    const { name, phone, email, tags, notes } = body;
    if (!name || !phone) return res.status(400).json({ error: 'name_and_phone_required' });
    const { data, error } = await sb.from('contacts')
      .insert({ client_id: clientId, name, phone, email, tags: tags || [], notes, source: 'manual' })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ contact: data });
  }
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...patch } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });
    delete patch.client_id; delete patch.created_at;
    const { data, error } = await sb.from('contacts').update(patch).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ contact: data });
  }
  if (req.method === 'DELETE') {
    const { id } = await readJson(req);
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { error } = await sb.from('contacts').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleBookings(req, res, ctx) {
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('bookings').select('*, contacts(name, phone)')
      .eq('client_id', clientId).order('starts_at', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ bookings: data });
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    const { contact_id, service, starts_at, status, notes } = body;
    if (!service || !starts_at) return res.status(400).json({ error: 'missing_fields' });
    const { data, error } = await sb.from('bookings').insert({
      client_id: clientId, contact_id, service, starts_at, status: status || 'scheduled', notes
    }).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ booking: data });
  }
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...patch } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });
    delete patch.client_id;
    const { data, error } = await sb.from('bookings').update(patch).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ booking: data });
  }
  if (req.method === 'DELETE') {
    const { id } = await readJson(req);
    const { error } = await sb.from('bookings').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleLeads(req, res, ctx) {
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const { data, error } = await sb
      .from('leads')
      .select('id, name, phone, email, source, status, notes, tags, funnel, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ leads: data || [] });
  }
  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...patch } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });
    delete patch.client_id; delete patch.created_at;
    const { data, error } = await sb.from('leads').update(patch).eq('id', id).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ lead: data });
  }
  if (req.method === 'DELETE') {
    const { id } = await readJson(req);
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { error } = await sb.from('leads').delete().eq('id', id);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method_not_allowed' });
}

async function handleVapiCalls(req, res, ctx) {
  const { sb, clientId } = ctx;
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
  const { data, error } = await sb
    .from('vapi_calls')
    .select('id, vapi_call_id, direction, from_number, to_number, customer_number, status, ended_reason, started_at, ended_at, duration_seconds, recording_url, summary, cost_cents, created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ vapi_calls: data || [] });
}

async function handleContactsImport(req, res, ctx) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  const { sb, clientId } = ctx;
  const body = await readJson(req);
  const { contacts } = body;
  if (!Array.isArray(contacts) || !contacts.length)
    return res.status(400).json({ error: 'contacts_array_required' });
  if (contacts.length > 5000)
    return res.status(400).json({ error: 'max_5000_contacts_per_import' });

  let created = 0, updated = 0, errors = [];
  // Process in batches of 200 for upsert
  const BATCH = 200;
  for (let i = 0; i < contacts.length; i += BATCH) {
    const batch = contacts.slice(i, i + BATCH).map(c => ({
      client_id: clientId,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'Unknown',
      phone: (c.phone || '').replace(/[^\d+]/g, ''),
      email: c.email || null,
      tags: c.tag ? [c.tag] : [],
      notes: c.notes || null,
      source: 'import'
    })).filter(c => c.phone);

    if (!batch.length) continue;

    const { data, error } = await sb.from('contacts')
      .upsert(batch, { onConflict: 'client_id,phone', ignoreDuplicates: false })
      .select('id');
    if (error) {
      errors.push({ batch: i, message: error.message });
    } else {
      created += (data || []).length;
    }
  }

  return res.status(200).json({ created, updated, errors, total: contacts.length });
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');
  if (action === 'contacts')        return handleContacts(req, res, ctx);
  if (action === 'contacts-import') return handleContactsImport(req, res, ctx);
  if (action === 'bookings')        return handleBookings(req, res, ctx);
  if (action === 'leads')           return handleLeads(req, res, ctx);
  if (action === 'vapi_calls')      return handleVapiCalls(req, res, ctx);
  return res.status(400).json({ error: 'unknown_action' });
}
