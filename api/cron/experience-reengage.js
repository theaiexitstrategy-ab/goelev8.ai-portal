// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
//
// Vercel cron: email re-engagement for experience tenants. All logic,
// copy and cadence live in lib/experience-reengage.js; this is the trigger.
//
// vercel.json entry:
//   { "path": "/api/cron/experience-reengage", "schedule": "*/10 * * * *" }
//
// ?dry=1 reports what WOULD be sent without sending or writing anything.
// Auth: Authorization: Bearer <CRON_SECRET>, the same as the other crons.
// Pause everything without a deploy: set REENGAGE_PAUSED=1.

import { runReengagement } from '../../lib/experience-reengage.js';

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (provided !== expected) return res.status(401).json({ error: 'unauthorized' });
  }
  const dry = String(req.query?.dry || '') === '1';
  try {
    const summary = await runReengagement({ dry });
    return res.status(200).json(summary);
  } catch (e) {
    console.error('[experience-reengage]', e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
