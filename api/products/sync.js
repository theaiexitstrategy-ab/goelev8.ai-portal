// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
// Universal funnel product sync — POSTs active funnel products to client websites.
// Works for ANY client, not just flex-facility.

import { requireUser, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const ctx = await requireUser(req, res);
  if (!ctx) return;

  const { clientId } = ctx;

  // Get the client's funnel_sync_url
  const { data: client } = await supabaseAdmin
    .from('clients')
    .select('slug, funnel_sync_url')
    .eq('id', clientId)
    .single();

  if (!client?.funnel_sync_url) {
    return res.status(400).json({ error: 'no_funnel_sync_url', message: 'No funnel sync URL configured for this client.' });
  }

  // Get all active funnel products for this client
  const { data: products } = await supabaseAdmin
    .from('products')
    .select('id, name, description, price, currency, stripe_payment_link, image_url, funnel_pages, display_order')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .eq('show_in_funnel', true)
    .order('display_order', { ascending: true });

  // POST to the client's website
  try {
    const syncRes = await fetch(client.funnel_sync_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GoElev8-Sync': 'true'
      },
      body: JSON.stringify({
        client_slug: client.slug,
        products: products || [],
        synced_at: new Date().toISOString()
      })
    });

    if (!syncRes.ok) {
      const errText = await syncRes.text().catch(() => 'Unknown error');
      return res.status(502).json({ error: 'sync_failed', message: `Client site returned ${syncRes.status}: ${errText}` });
    }

    return res.json({
      synced: true,
      products_count: (products || []).length,
      sync_url: client.funnel_sync_url
    });
  } catch (e) {
    return res.status(502).json({ error: 'sync_failed', message: e.message });
  }
}
