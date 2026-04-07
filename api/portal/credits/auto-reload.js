import { requireUser, methodGuard, readJson } from '../../../lib/auth.js';
import { supabaseAdmin } from '../../../lib/supabase.js';
import { getPack } from '../../../lib/credits.js';

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { enabled, threshold, pack } = await readJson(req);
  if (pack && !getPack(pack)) return res.status(400).json({ error: 'invalid_pack' });
  const patch = {};
  if (typeof enabled === 'boolean') patch.auto_reload_enabled = enabled;
  if (Number.isInteger(threshold)) patch.auto_reload_threshold = threshold;
  if (pack) patch.auto_reload_pack = pack;
  const { data, error } = await supabaseAdmin.from('clients').update(patch).eq('id', ctx.clientId).select().single();
  if (error) return res.status(400).json({ error: error.message });
  return res.status(200).json({ client: data });
}
