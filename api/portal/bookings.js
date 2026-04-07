import { requireUser, methodGuard, readJson } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('bookings')
      .select('*, contacts(name, phone)')
      .eq('client_id', clientId)
      .order('starts_at', { ascending: true });
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
}
