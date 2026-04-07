// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Vapi webhook receiver. Uses the Supabase service role key to bypass RLS,
// and is gated by a shared secret in the x-vapi-secret header.

import { supabaseAdmin } from '../../lib/supabase.js';

const OUTCOME_MAP = {
  customerHangup: 'Hung Up',
  assistantHangup: 'Completed',
  voicemail: 'Voicemail'
};

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Resolve which client this call belongs to. Strategy:
//   1. If a lead already exists for this phone, use that lead's client_id.
//   2. Otherwise fall back to DEFAULT_CLIENT_ID from env.
async function resolveClientId(phone) {
  if (phone) {
    const { data } = await supabaseAdmin
      .from('leads')
      .select('client_id')
      .eq('phone', phone)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.client_id) return data.client_id;
  }
  return process.env.DEFAULT_CLIENT_ID || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Shared-secret verification
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return res.status(500).json({ error: 'webhook_secret_not_configured' });
  if (req.headers['x-vapi-secret'] !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  let body;
  try { body = await readJson(req); }
  catch { return res.status(400).json({ error: 'invalid_json' }); }

  // Vapi sometimes nests the event under `message` — accept both shapes.
  const evt = body?.message || body || {};
  const type = evt.type || body?.type;
  const call = evt.call || body?.call;

  if (!type || !call) return res.status(400).json({ error: 'missing_type_or_call' });

  const phone = call.customer?.number || null;
  const clientId = await resolveClientId(phone);
  if (!clientId) return res.status(400).json({ error: 'no_client_resolved' });

  try {
    if (type === 'call.started') {
      // Upsert a lead if we don't already have one for this phone under this client.
      if (phone) {
        const { data: existing } = await supabaseAdmin
          .from('leads')
          .select('id')
          .eq('client_id', clientId)
          .eq('phone', phone)
          .maybeSingle();
        if (!existing) {
          const { error } = await supabaseAdmin.from('leads').insert({
            client_id: clientId,
            name: phone,
            phone,
            source: 'Vapi',
            status: 'Contacted',
            created_at: new Date().toISOString()
          });
          if (error) return res.status(500).json({ error: error.message });
        }
      }
      return res.status(200).json({ ok: true, handled: 'call.started' });
    }

    if (type === 'call.ended') {
      const outcome = OUTCOME_MAP[call.endedReason] || call.endedReason || null;
      const { error } = await supabaseAdmin.from('vapi_calls').insert({
        client_id: clientId,
        caller_phone: phone,
        duration_seconds: Number(call.duration) || 0,
        outcome,
        transcript: call.transcript || null,
        vapi_call_id: call.id || null,
        created_at: new Date().toISOString()
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, handled: 'call.ended' });
    }

    // Unknown event type — ack without action so Vapi doesn't retry forever.
    return res.status(200).json({ ok: true, ignored: type });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'server_error' });
  }
}
