// Shared helper: send a welcome SMS for a freshly-ingested client_event.
// Used by api/events.js (ingest path). Mirrors the credit/refund/logging
// flow in api/portal/messages.js so welcome sends behave identically to
// manual sends.

import { supabaseAdmin } from './supabase.js';
import { twilioForClient, estimateSegments } from './twilio.js';

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    return v == null ? '' : String(v);
  }).replace(/\s+/g, ' ').trim();
}

function firstName(full) {
  if (!full) return '';
  return String(full).trim().split(/\s+/)[0] || '';
}

// Returns { sent: boolean, reason?: string, sid?: string }
// `event.lead_id` (optional) is persisted onto the messages row so the
// Messages tab can render the lead's name and so a thread can be
// resolved when the contact upsert hasn't happened yet.
export async function sendWelcomeForEvent({ client, event }) {
  if (!client?.welcome_sms_enabled) return { sent: false, reason: 'disabled' };
  if (!client?.welcome_sms_template) return { sent: false, reason: 'no_template' };
  if (!client?.twilio_phone_number)  return { sent: false, reason: 'no_twilio_number' };
  if (!event?.contact_phone)         return { sent: false, reason: 'no_phone' };

  const to = String(event.contact_phone).trim();
  if (!/^\+?\d[\d\s\-().]{6,}$/.test(to)) return { sent: false, reason: 'invalid_phone' };

  // Find or create contact for this phone (so the welcome shows up in the
  // Messages thread alongside any later replies).
  let contactId = null;
  {
    const { data: existing } = await supabaseAdmin
      .from('contacts')
      .select('id, opted_out')
      .eq('client_id', client.id)
      .eq('phone', to)
      .maybeSingle();
    if (existing) {
      if (existing.opted_out) return { sent: false, reason: 'opted_out' };
      contactId = existing.id;
    } else {
      const { data: created, error: cErr } = await supabaseAdmin
        .from('contacts')
        .insert({
          client_id: client.id,
          phone: to,
          name: event.contact_name || null,
          email: event.contact_email || null,
          source: event.source || null
        })
        .select('id')
        .single();
      if (cErr) return { sent: false, reason: 'contact_create_failed: ' + cErr.message };
      contactId = created.id;
    }
  }

  const text = renderTemplate(client.welcome_sms_template, {
    name:        event.contact_name || '',
    first_name:  firstName(event.contact_name),
    client_name: client.name || '',
    source:      event.source || '',
    source_path: event.source_path || ''
  });
  if (!text) return { sent: false, reason: 'empty_after_render' };

  const segments = estimateSegments(text);
  if ((client.credit_balance ?? 0) < segments) {
    return { sent: false, reason: 'insufficient_credits' };
  }

  // Atomic deduct
  const { data: newBal, error: dErr } = await supabaseAdmin
    .rpc('consume_credits', { p_client_id: client.id, p_amount: segments });
  if (dErr) return { sent: false, reason: 'consume_failed' };

  // Send via Twilio (per-tenant subaccount if configured)
  const tw = twilioForClient(client);
  let twilioMsg;
  try {
    twilioMsg = await tw.messages.create({
      from: client.twilio_phone_number,
      to,
      body: text,
      statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
    });
  } catch (err) {
    // Refund on hard failure
    await supabaseAdmin.rpc('add_credits', { p_client_id: client.id, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: client.id, delta: segments, reason: 'refund', ref_id: 'welcome_send_failed'
    });
    return { sent: false, reason: 'twilio_failed: ' + err.message };
  }

  await supabaseAdmin.from('messages').insert({
    client_id: client.id,
    contact_id: contactId,
    lead_id: event.lead_id || null,
    direction: 'outbound',
    body: text,
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: to,
    from_number: client.twilio_phone_number,
    credits_charged: segments
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id: client.id, delta: -segments, reason: 'welcome_sms', ref_id: twilioMsg.sid
  });

  return { sent: true, sid: twilioMsg.sid, balance: newBal, segments };
}
