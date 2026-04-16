// ONE-TIME migration endpoint. Delete this file after running.
// GET /api/run-migration-0022
import { supabaseAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  try {
    // 1. Make client_id nullable
    const { error: e1 } = await supabaseAdmin.rpc('exec_sql', {
      sql: 'ALTER TABLE public.push_subscriptions ALTER COLUMN client_id DROP NOT NULL'
    }).maybeSingle();

    // If rpc doesn't exist, try raw query via supabaseAdmin
    // The admin client can execute schema changes via postgres function
    if (e1) {
      // Fallback: just test by inserting with null client_id
      const { error: insertErr } = await supabaseAdmin
        .from('push_subscriptions')
        .insert({ client_id: null, user_id: '00000000-0000-0000-0000-000000000000', endpoint: 'test://migration-check', p256dh: 'test', auth: 'test' });

      if (insertErr && insertErr.message.includes('not-null')) {
        return res.status(200).json({
          status: 'needs_manual_migration',
          message: 'client_id is still NOT NULL. Run this SQL in the Supabase SQL Editor:',
          sql: 'ALTER TABLE public.push_subscriptions ALTER COLUMN client_id DROP NOT NULL;'
        });
      }

      // Clean up test row
      await supabaseAdmin.from('push_subscriptions').delete().eq('endpoint', 'test://migration-check');
      return res.status(200).json({ status: 'already_nullable', message: 'client_id is already nullable — migration not needed' });
    }

    return res.status(200).json({ status: 'migrated', message: 'client_id is now nullable' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
