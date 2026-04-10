// Artist roster CRUD — scoped to the client.
// GET    — list artists
// POST   — create artist
// PATCH  — update artist
// DELETE — remove artist

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  if (req.method === 'GET') {
    const { data, error } = await supabaseAdmin
      .from('artists')
      .select('*')
      .eq('client_id', clientId)
      .order('name');
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ artists: data || [] });
  }

  if (req.method === 'POST') {
    const body = await readJson(req);
    const { name, specialty, booking_url, photo_url } = body;
    if (!name) return res.status(400).json({ error: 'name_required' });
    const { data, error } = await supabaseAdmin
      .from('artists')
      .insert({ client_id: clientId, name, specialty, booking_url, photo_url })
      .select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(201).json({ artist: data });
  }

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const { id, ...patch } = body;
    if (!id) return res.status(400).json({ error: 'id_required' });
    delete patch.client_id;
    const { data, error } = await supabaseAdmin
      .from('artists').update(patch).eq('id', id).eq('client_id', clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ artist: data });
  }

  if (req.method === 'DELETE') {
    const { id } = await readJson(req);
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { error } = await supabaseAdmin
      .from('artists').delete().eq('id', id).eq('client_id', clientId);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
}
