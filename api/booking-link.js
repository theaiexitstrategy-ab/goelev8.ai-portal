// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved. Unauthorized use prohibited.
// Public Vapi function tool: returns the canonical booking link for a
// tenant so the voice assistant always reads the right URL aloud.
//
// Configure the Vapi assistant tool to POST here. Vapi's wrapper:
//   { message: { type: 'tool-calls', toolCalls: [{ id, function: { name, arguments } }] } }
// Arguments accepted: { slug?: string }   (defaults to 'flex-facility')
// Response: Vapi tool-result shape with the URL embedded in a sentence
// the assistant can speak verbatim, or call directly via:
//   GET /api/booking-link?slug=flex-facility
//
// Source of truth: clients.slug -> booking_calendars.custom_domain (or
// booking_calendars.slug under book.goelev8.ai). Single field, so
// rotating the booking page never leaves the assistant on a stale URL.

import { supabaseAdmin } from '../lib/supabase.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vapi-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Optional Vapi-only lock — set VAPI_WEBHOOK_SECRET in env to enforce.
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers['x-vapi-secret'] || req.headers['X-Vapi-Secret'];
    if (provided !== secret) return res.status(401).json({ error: 'unauthorized' });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  let slug = url.searchParams.get('slug') || 'flex-facility';
  let vapiToolCallId = null;

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'object' && req.body
        ? req.body
        : JSON.parse(await new Promise((r, e) => {
            let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); req.on('error', e);
          }));
      const toolCall = body?.message?.toolCalls?.[0] || body?.toolCalls?.[0];
      if (toolCall) {
        vapiToolCallId = toolCall.id;
        const args = toolCall.function?.arguments || {};
        if (args.slug) slug = args.slug;
      }
    } catch { /* not a Vapi call — fall back to query slug */ }
  }

  const { data: client } = await supabaseAdmin
    .from('clients').select('id, name').eq('slug', slug).maybeSingle();
  if (!client) {
    return vapiToolCallId
      ? res.status(200).json({ results: [{ toolCallId: vapiToolCallId, result: 'I could not find that business. Please check our website.' }] })
      : res.status(404).json({ error: 'client_not_found' });
  }

  const { data: cal } = await supabaseAdmin
    .from('booking_calendars').select('custom_domain, slug')
    .eq('business_id', client.id).maybeSingle();

  let bookingUrl = '';
  if (cal?.custom_domain) bookingUrl = 'https://' + cal.custom_domain.replace(/^https?:\/\//, '');
  else if (cal?.slug)     bookingUrl = `https://book.goelev8.ai/${cal.slug}`;

  if (!bookingUrl) {
    return vapiToolCallId
      ? res.status(200).json({ results: [{ toolCallId: vapiToolCallId, result: 'Our booking page is being updated. Please check our website.' }] })
      : res.status(200).json({ booking_url: '', client: client.name });
  }

  // Strip protocol for spoken responses — easier to dictate.
  const spoken = bookingUrl.replace(/^https?:\/\//, '');
  const sentence = `You can book online at ${spoken}.`;

  if (vapiToolCallId) {
    return res.status(200).json({
      results: [{ toolCallId: vapiToolCallId, result: sentence }]
    });
  }
  return res.status(200).json({
    client: client.name,
    booking_url: bookingUrl,
    spoken_url: spoken,
    sentence
  });
}
