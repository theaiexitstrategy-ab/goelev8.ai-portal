// Lead management endpoint.
// GET   — list leads for the client
// PATCH — update a lead
// DELETE — remove a lead

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'PATCH', 'DELETE'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const { data, error } = await supabaseAdmin
      .from('leads')
      .select('*')
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
    const { data, error } = await supabaseAdmin
      .from('leads').update(patch).eq('id', id).eq('client_id', clientId).select().single();
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ lead: data });
  }

  if (req.method === 'DELETE') {
    const { id } = await readJson(req);
    if (!id) return res.status(400).json({ error: 'id_required' });
    const { error } = await supabaseAdmin
      .from('leads').delete().eq('id', id).eq('client_id', clientId);
    if (error) return res.status(400).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }
}
