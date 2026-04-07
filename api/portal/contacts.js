import { requireUser, methodGuard, readJson } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('contacts')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ contacts: data });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { name, phone, email, tags, notes } = body;
    if (!name || !phone) return res.status(400).json({ error: 'name_and_phone_required' });
    const { data, error } = await sb
      .from('contacts')
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
}
