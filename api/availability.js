// Public availability endpoint — returns services + weekly schedules for a
// client, in both structured JSON and AI-friendly text form.
//
// Used by:
//   1. Vapi function tools — the assistant calls this during a phone call
//      when the caller asks "when are you open?" or "what sessions do you
//      offer?". Vapi POSTs with its toolCalls wrapper; we respond in Vapi's
//      expected { results: [{ toolCallId, result }] } shape.
//   2. Direct GET (for debugging / other integrations):
//      GET /api/availability?slug=flex-facility&format=text
//
// No auth required — the data is publicly visible on the booking page
// already. An optional VAPI_WEBHOOK_SECRET check validates the x-vapi-secret
// header if the env var is set, so you can lock this endpoint to Vapi-only
// calls in production.
//
// Data source: booking_services + availability_templates (same tables the
// portal Bookings tab manages and the booking widget reads from).

import { supabaseAdmin } from '../lib/supabase.js';

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function formatTime12h(t) {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Build a human-readable text block an AI voice assistant can speak
// naturally. Example:
//
//   The Flex Facility offers 3 sessions:
//   1. Free Athlete Performance Assessment (max 10 athletes per session)
//      Available: Sunday 8:30 AM, Monday 7:00 PM, ...
//   ...
//   All times are Central (America/Chicago).
//   To book, direct the caller to book.theflexfacility.com
function buildDisplayText(services, timezone, bookingUrl) {
  if (!services.length) return 'No services are currently available for booking.';
  const lines = [`The Flex Facility offers ${services.length} session${services.length === 1 ? '' : 's'}:\n`];

  for (let i = 0; i < services.length; i++) {
    const s = services[i];
    const cap = s.maxPerSlot ? ` (max ${s.maxPerSlot} per session)` : '';
    lines.push(`${i + 1}. ${s.fullName}${cap}`);
    if (!s.daySlots.length) {
      lines.push('   Not currently scheduled.\n');
      continue;
    }
    const dayParts = s.daySlots.map(d => `${d.day} at ${d.times.join(', ')}`);
    lines.push(`   Available: ${dayParts.join('; ')}\n`);
  }

  if (timezone)   lines.push(`All times are ${timezone}.`);
  if (bookingUrl) lines.push(`To book, direct the caller to ${bookingUrl}`);
  return lines.join('\n');
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vapi-secret');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Optional secret check — keeps the endpoint locked to Vapi-only if set.
  const secret = process.env.VAPI_WEBHOOK_SECRET;
  if (secret) {
    const provided = req.headers['x-vapi-secret'] || req.headers['X-Vapi-Secret'];
    if (provided !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // Extract slug from either query param (GET) or Vapi's toolCalls body (POST).
  const url = new URL(req.url, `http://${req.headers.host}`);
  let slug = url.searchParams.get('slug') || 'flex-facility';
  let vapiToolCallId = null;

  // Vapi sends POST { message: { type: "tool-calls", toolCalls: [{ id, function: { name, arguments } }] } }
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'object' ? req.body : JSON.parse(await new Promise((r, e) => {
        let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); req.on('error', e);
      }));
      const toolCall = body?.message?.toolCalls?.[0] || body?.toolCalls?.[0];
      if (toolCall) {
        vapiToolCallId = toolCall.id;
        const args = toolCall.function?.arguments || {};
        if (args.slug) slug = args.slug;
      }
    } catch { /* not a Vapi call — use query params */ }
  }

  try {
    // Resolve client
    const { data: client, error: clientErr } = await supabaseAdmin
      .from('clients').select('id, name').eq('slug', slug).maybeSingle();
    if (clientErr) throw clientErr;
    if (!client) return res.status(404).json({ error: 'client_not_found' });

    // Get calendar for timezone + booking URL
    const { data: cal } = await supabaseAdmin
      .from('booking_calendars').select('timezone, custom_domain, slug')
      .eq('business_id', client.id).maybeSingle();
    const timezone = cal?.timezone || 'America/Chicago';
    const bookingUrl = cal?.custom_domain
      ? `https://${cal.custom_domain}`
      : (cal?.slug ? `https://book.goelev8.ai/${cal.slug}` : null);

    // Pull active services + templates
    const { data: services, error: svcErr } = await supabaseAdmin
      .from('booking_services')
      .select('id, key, name, full_name, max_per_slot')
      .eq('client_id', client.id)
      .eq('is_active', true)
      .order('sort_order', { ascending: true });
    if (svcErr) throw svcErr;

    const svcIds = (services || []).map(s => s.id);
    let templates = [];
    if (svcIds.length) {
      const { data: tpl, error: tplErr } = await supabaseAdmin
        .from('availability_templates')
        .select('service_id, day_of_week, start_time')
        .in('service_id', svcIds)
        .eq('is_active', true)
        .order('day_of_week').order('start_time');
      if (tplErr) throw tplErr;
      templates = tpl || [];
    }

    // Group templates by service, then by day
    const tplByService = {};
    for (const t of templates) {
      if (!tplByService[t.service_id]) tplByService[t.service_id] = {};
      const dow = t.day_of_week;
      if (!tplByService[t.service_id][dow]) tplByService[t.service_id][dow] = [];
      tplByService[t.service_id][dow].push(formatTime12h(t.start_time));
    }

    const enriched = (services || []).map(s => {
      const byDow = tplByService[s.id] || {};
      // Flatten to an array of { day, times } for both structured + text output.
      const daySlots = [];
      for (let dow = 0; dow < 7; dow++) {
        if (byDow[dow]?.length) {
          daySlots.push({ day: DAY_NAMES[dow], times: byDow[dow] });
        }
      }
      return {
        key:         s.key,
        name:        s.name,
        fullName:    s.full_name,
        maxPerSlot:  s.max_per_slot,
        daySlots
      };
    });

    const displayText = buildDisplayText(enriched, timezone, bookingUrl);

    // Response shape depends on who's calling.
    const format = url.searchParams.get('format');

    // Vapi function tool response shape.
    if (vapiToolCallId) {
      return res.status(200).json({
        results: [{
          toolCallId: vapiToolCallId,
          result: displayText
        }]
      });
    }

    // Plain text mode (for debugging, copy-paste, etc.)
    if (format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(displayText);
    }

    // Default: structured JSON.
    return res.status(200).json({
      client:      client.name,
      timezone,
      booking_url: bookingUrl,
      services:    enriched,
      display_text: displayText
    });
  } catch (e) {
    console.error('[availability] error:', e);

    // Even on error, if this is a Vapi tool call, wrap in the expected shape
    // so the assistant hears "sorry, check our website" instead of crashing.
    if (vapiToolCallId) {
      return res.status(200).json({
        results: [{
          toolCallId: vapiToolCallId,
          result: 'I\'m sorry, I couldn\'t load the current schedule right now. Please check our website for the latest availability.'
        }]
      });
    }
    return res.status(500).json({ error: e.message });
  }
}
