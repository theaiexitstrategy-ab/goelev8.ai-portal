// Client settings endpoint.
// GET  — fetch settings
// POST — update settings

import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { clientId } = ctx;

  if (req.method === 'GET') {
    const { data } = await supabaseAdmin
      .from('client_settings').select('*').eq('client_id', clientId).single();
    if (!data) {
      // Return defaults
      const { data: client } = await supabaseAdmin
        .from('clients').select('name, business_name').eq('id', clientId).single();
      return res.status(200).json({
        client_id: clientId,
        studio_name: client?.business_name || client?.name || '',
        owner_name: '',
        owner_email: null,
        owner_phone: null,
        promo_code: null,
        promo_amount: null,
        timezone: 'America/Chicago',
        notification_email: true,
        notification_sms: true,
        low_credit_threshold: 20
      });
    }
    return res.status(200).json(data);
  }

  // POST — update
  const body = await readJson(req);
  const allowedFields = [
    'studio_name', 'owner_name', 'owner_email', 'owner_phone',
    'promo_code', 'promo_amount', 'timezone',
    'notification_email', 'notification_sms', 'low_credit_threshold'
  ];
  const updates = {};
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key];
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'no_valid_fields' });
  }

  // Upsert
  const { data: existing } = await supabaseAdmin
    .from('client_settings').select('id').eq('client_id', clientId).single();

  if (existing) {
    await supabaseAdmin.from('client_settings').update(updates).eq('client_id', clientId);
  } else {
    await supabaseAdmin.from('client_settings').insert({ client_id: clientId, ...updates });
  }

  const { data } = await supabaseAdmin
    .from('client_settings').select('*').eq('client_id', clientId).single();
  return res.status(200).json(data);
}
