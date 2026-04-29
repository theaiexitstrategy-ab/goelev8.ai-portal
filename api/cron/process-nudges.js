// © 2026 GoElev8.ai | Aaron Bryant. All rights reserved.
//
// Cron worker that drains the nudge_queue table — nudge sequence
// messages 2..5 with delays > 10 minutes get persisted there by
// scheduleNudgeSequence() because Vercel serverless invocations can't
// hold a setTimeout that long. This route is invoked by Vercel cron
// (registered in vercel.json under "crons") on a fixed schedule and:
//
//   1. Selects every nudge_queue row whose scheduled_for is due, that
//      hasn't been sent yet, and that hasn't permanently failed.
//   2. Re-checks the contact opt-out status (a STOP between schedule
//      and fire must suppress the send).
//   3. Atomically deducts credits, fires the SMS via Twilio, and
//      writes a messages row + credit_ledger row using the same shape
//      as every other outbound send path.
//   4. Marks the queue row sent_at = now() (or failed_reason on hard
//      failure) so we never send the same nudge twice.
//
// Auth: Vercel cron sends an Authorization: Bearer <CRON_SECRET>
// header (the value of the CRON_SECRET env var). Manual invocations
// can also POST that header for testing.

import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments } from '../../lib/twilio.js';
import { toE164 } from '../../lib/phone.js';

const BATCH_SIZE = 50;

function authorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // dev mode — no secret configured
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return provided === expected;
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const nowIso = new Date().toISOString();

  // Pull due rows. Order oldest-first so backed-up sends drain in order.
  const { data: due, error: dueErr } = await supabaseAdmin
    .from('nudge_queue')
    .select('*')
    .lte('scheduled_for', nowIso)
    .is('sent_at', null)
    .is('failed_reason', null)
    .order('scheduled_for', { ascending: true })
    .limit(BATCH_SIZE);

  if (dueErr) return res.status(500).json({ error: dueErr.message });
  if (!due?.length) return res.status(200).json({ ok: true, processed: 0 });

  // Group by client_id so we only load each client/Twilio config once.
  const byClient = {};
  for (const row of due) {
    (byClient[row.client_id] ||= []).push(row);
  }

  let processed = 0, sent = 0, failed = 0, skipped = 0;

  for (const [clientId, rows] of Object.entries(byClient)) {
    const { data: client } = await supabaseAdmin
      .from('clients').select('*').eq('id', clientId).single();
    if (!client?.twilio_phone_number) {
      // Mark all rows for this client as failed so we don't retry forever.
      for (const r of rows) {
        await supabaseAdmin.from('nudge_queue')
          .update({ failed_reason: 'no_twilio_number' }).eq('id', r.id);
        failed++; processed++;
      }
      continue;
    }

    const tw = twilioForClient(client);

    for (const row of rows) {
      processed++;

      // Re-check opt-out (a STOP after the row was queued must suppress).
      if (row.contact_id) {
        const { data: c } = await supabaseAdmin
          .from('contacts').select('opted_out').eq('id', row.contact_id).maybeSingle();
        if (c?.opted_out) {
          await supabaseAdmin.from('nudge_queue')
            .update({ failed_reason: 'opted_out' }).eq('id', row.id);
          skipped++;
          continue;
        }
      }

      const text = row.message_body;
      const segments = estimateSegments(text);

      // Refresh balance per send (other sends may have drained it).
      const { data: freshClient } = await supabaseAdmin
        .from('clients').select('credit_balance').eq('id', clientId).single();
      if ((freshClient?.credit_balance ?? 0) < segments) {
        await supabaseAdmin.from('nudge_queue')
          .update({ failed_reason: 'insufficient_credits' }).eq('id', row.id);
        failed++;
        continue;
      }

      const { error: dErr } = await supabaseAdmin
        .rpc('consume_credits', { p_client_id: clientId, p_amount: segments });
      if (dErr) {
        await supabaseAdmin.from('nudge_queue')
          .update({ failed_reason: 'consume_failed' }).eq('id', row.id);
        failed++;
        continue;
      }

      // Defensive E.164 normalization — queued rows may pre-date the
      // intake-side normalization. Twilio rejects bare 10-digit numbers.
      const toE = toE164(row.to_number);
      if (!toE) {
        await supabaseAdmin.rpc('add_credits', { p_client_id: clientId, p_amount: segments });
        await supabaseAdmin.from('nudge_queue')
          .update({ failed_reason: 'invalid_phone' }).eq('id', row.id);
        failed++;
        continue;
      }
      let twilioMsg;
      try {
        twilioMsg = await tw.messages.create({
          from: client.twilio_phone_number,
          to: toE,
          body: text,
          statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
        });
      } catch (err) {
        // Refund credits and mark the row failed.
        await supabaseAdmin.rpc('add_credits', { p_client_id: clientId, p_amount: segments });
        await supabaseAdmin.from('credit_ledger').insert({
          client_id: clientId, delta: segments, reason: 'refund',
          ref_id: `nudge_queue_${row.id}_failed`
        });
        await supabaseAdmin.from('nudge_queue')
          .update({ failed_reason: 'twilio_failed: ' + (err.message || 'unknown') })
          .eq('id', row.id);
        failed++;
        continue;
      }

      // Persist the send so it shows up in the Messages tab thread.
      await supabaseAdmin.from('messages').insert({
        client_id: clientId,
        contact_id: row.contact_id || null,
        lead_id: row.lead_id || null,
        direction: 'outbound',
        body: text,
        segments,
        twilio_sid: twilioMsg.sid,
        status: twilioMsg.status,
        to_number: row.to_number,
        from_number: client.twilio_phone_number,
        credits_charged: segments
      });
      await supabaseAdmin.from('credit_ledger').insert({
        client_id: clientId, delta: -segments, reason: 'nudge_sms',
        ref_id: twilioMsg.sid
      });
      await supabaseAdmin.from('nudge_queue')
        .update({ sent_at: new Date().toISOString() }).eq('id', row.id);

      sent++;
    }
  }

  return res.status(200).json({ ok: true, processed, sent, failed, skipped });
}
