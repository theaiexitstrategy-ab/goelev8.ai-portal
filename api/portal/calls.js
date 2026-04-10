// Voice calls (Vapi) endpoint.
// GET  — list calls for the client
// POST — trigger an outbound call via Vapi

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  // ---------- GET: list calls ----------
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);
    const { data, error } = await supabaseAdmin
      .from('vapi_calls')
      .select('id, vapi_call_id, direction, from_number, to_number, customer_number, status, ended_reason, started_at, ended_at, duration_seconds, recording_url, summary, cost_cents, created_at')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ calls: data || [] });
  }

  // ---------- POST: outbound call via Vapi ----------
  const { phone_number } = await readJson(req);
  if (!phone_number) return res.status(400).json({ error: 'phone_number_required' });

  // Look up the client's vapi_assistant_id
  const { data: client } = await supabaseAdmin
    .from('clients').select('vapi_assistant_id').eq('id', clientId).single();
  const assistantId = client?.vapi_assistant_id;
  if (!assistantId) return res.status(400).json({ error: 'no_vapi_assistant_configured' });

  const vapiKey = process.env.VAPI_API_KEY;
  if (!vapiKey) return res.status(500).json({ error: 'VAPI_API_KEY not configured' });

  try {
    const vapiRes = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vapiKey}`
      },
      body: JSON.stringify({
        assistantId,
        customer: { number: phone_number }
      })
    });
    const vapiData = await vapiRes.json();
    if (!vapiRes.ok) return res.status(vapiRes.status).json({ error: vapiData.message || 'Vapi error' });
    return res.status(200).json({ call: vapiData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
