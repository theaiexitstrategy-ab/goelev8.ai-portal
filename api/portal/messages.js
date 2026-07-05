import { requireUser, methodGuard, readJson } from '../../lib/auth.js';
import { supabaseAdmin } from '../../lib/supabase.js';
import { twilioForClient, estimateSegments, truncateForSms, creditsForSend, MMS_CREDIT_COST } from '../../lib/twilio.js';
import { toE164 } from '../../lib/phone.js';
import { getBillingClient } from '../../lib/credits.js';

// Bucket for MMS attachments — outbound-sent images plus inbound MMS
// re-hosted from Twilio. Public so Twilio can fetch outbound URLs when
// sending, and so the browser can render <img> inline in message bubbles
// without proxy auth.
const MMS_BUCKET = 'mms-attachments';

// Upload a base64 data URI to the mms-attachments bucket, returning the
// public HTTPS URL. Mirrors the merch.js upload pattern — auto-creates
// the bucket on 'not found' so a missed migration doesn't stall the
// operator. 10 MB ceiling matches the merch limit.
async function uploadMmsAttachment(clientId, dataUrl, filename) {
  if (!dataUrl || !dataUrl.startsWith('data:')) {
    return { error: 'data_url_required' };
  }
  const m = dataUrl.match(/^data:([\w/+.-]+);base64,(.+)$/);
  if (!m) return { error: 'invalid_data_url' };
  const mime = m[1];
  const b64  = m[2];
  if (!/^image\//i.test(mime)) return { error: 'only_image_uploads_allowed' };
  const sizeBytes = Math.floor(b64.length * 0.75);
  if (sizeBytes > 10 * 1024 * 1024) return { error: 'image_too_large', max_bytes: 10 * 1024 * 1024 };
  const buf = Buffer.from(b64, 'base64');
  const extFromMime = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif',  'image/webp': 'webp', 'image/heic': 'heic'
  }[mime.toLowerCase()] || 'jpg';
  const safeName = String(filename || '').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60);
  const baseName = safeName ? safeName.replace(/\.[^.]+$/, '') : 'photo';
  const path = `${clientId}/${Date.now()}-${baseName}.${extFromMime}`;

  let upErr;
  {
    const r = await supabaseAdmin.storage.from(MMS_BUCKET)
      .upload(path, buf, { contentType: mime, upsert: false });
    upErr = r.error;
  }
  if (upErr && /Bucket not found/i.test(upErr.message || '')) {
    const created = await supabaseAdmin.storage.createBucket(MMS_BUCKET, { public: true });
    if (created.error && !/already exists/i.test(created.error.message || '')) {
      return { error: 'could_not_create_bucket: ' + created.error.message };
    }
    const retry = await supabaseAdmin.storage.from(MMS_BUCKET)
      .upload(path, buf, { contentType: mime, upsert: false });
    upErr = retry.error;
  }
  if (upErr) return { error: 'upload_failed: ' + upErr.message };
  const { data: pub } = supabaseAdmin.storage.from(MMS_BUCKET).getPublicUrl(path);
  return { url: pub?.publicUrl, path };
}

// Wrapper around supabaseAdmin.from('messages').insert() that retries
// without the media_url / is_mms columns if the migration hasn't landed
// on this env yet. Keeps the send path resilient across environments
// that are still on 0030 schema.
async function insertMessageRow(row) {
  const { error } = await supabaseAdmin.from('messages').insert(row);
  if (error && /column .*(media_url|is_mms).* does not exist/i.test(error.message || '')) {
    const { media_url: _m, is_mms: _i, ...legacy } = row;
    await supabaseAdmin.from('messages').insert(legacy);
  }
}

export default async function handler(req, res) {
  if (!methodGuard(req, res, ['GET', 'POST'])) return;
  const ctx = await requireUser(req, res); if (!ctx) return;
  const { sb, clientId } = ctx;

  // ---------- POST ?action=upload-mms — upload attachment, get URL ----------
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'POST' && url.searchParams.get('action') === 'upload-mms') {
    const body = await readJson(req);
    const result = await uploadMmsAttachment(clientId, body?.data_url, body?.filename);
    if (result.error) return res.status(400).json(result);
    return res.status(200).json(result);
  }

  // GET: list messages, optionally for one contact (?contact_id=)
  // Uses supabaseAdmin (service-role) instead of the user-scoped client
  // because inbound messages are inserted by the Twilio webhook handler
  // (also via supabaseAdmin). The user-scoped JWT+RLS path can fail to
  // surface those rows when the session context for current_client_id()
  // doesn't propagate cleanly. The clientId is already validated by
  // requireUser(), so tenant isolation is still enforced.
  if (req.method === 'GET') {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const contactId = url.searchParams.get('contact_id');
    let q = supabaseAdmin.from('messages').select('*').eq('client_id', clientId)
      .order('created_at', { ascending: false }).limit(1000);
    if (contactId) q = q.eq('contact_id', contactId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ messages: data || [] });
  }

  // POST: send an SMS (or MMS if media_url is set)
  const body = await readJson(req);
  const { contact_id, to, body: text, media_url } = body;
  const hasMedia = !!media_url;
  // MMS may have an empty body — Twilio accepts image-only messages.
  // For SMS, body remains required.
  if ((!text && !hasMedia) || (!contact_id && !to)) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  // Resolve contact + destination number (verify ownership via RLS-bound select)
  let contact = null;
  let destNumber = to;
  if (contact_id) {
    const { data, error } = await sb.from('contacts').select('*').eq('id', contact_id).single();
    if (error || !data) return res.status(404).json({ error: 'contact_not_found' });
    contact = data;
    destNumber = data.phone;
    if (data.opted_out) return res.status(400).json({ error: 'contact_opted_out' });
  }

  // Load client (for parent linkage + tenant scope), then resolve to
  // the billing client (parent, if any). Tenants like Will Power Fitness
  // Factory have no Twilio number / credit pool of their own — they
  // share Flex Facility's via parent_client_id.
  const { data: client, error: cErr } = await supabaseAdmin
    .from('clients').select('*').eq('id', clientId).single();
  if (cErr || !client) return res.status(500).json({ error: 'client_not_found' });
  const billingClient = await getBillingClient(supabaseAdmin, client);
  if (!billingClient.twilio_phone_number) return res.status(400).json({ error: 'no_twilio_number' });
  const billingId = billingClient.id;

  const e164 = toE164(destNumber);
  if (!e164) return res.status(400).json({ error: 'invalid_phone', detail: destNumber });
  destNumber = e164;

  // Credit math: SMS bills per segment; MMS is a flat MMS_CREDIT_COST
  // regardless of body length (Twilio bills MMS per message, not per
  // segment). creditsForSend() picks the right one based on hasMedia.
  const segments = creditsForSend(text, hasMedia);
  if (billingClient.credit_balance < segments) {
    return res.status(402).json({ error: 'insufficient_credits', need: segments, have: billingClient.credit_balance });
  }

  // Atomically deduct credits BEFORE sending (prevents oversend on race).
  // The debit hits the BILLING client (parent), so the shared pool is
  // the single source of truth for both portals.
  const { data: newBal, error: dErr } = await supabaseAdmin
    .rpc('consume_credits', { p_client_id: billingId, p_amount: segments });
  if (dErr) return res.status(402).json({ error: 'insufficient_credits' });

  // Send via Twilio (per-tenant subaccount if configured on the billing client).
  const tw = twilioForClient(billingClient);
  // MMS bodies are NOT truncated — MMS supports up to 5000 chars in a
  // single message. Only SMS gets the 160-char ceiling.
  const twilioBody = hasMedia ? (text || '') : truncateForSms(text);
  const twilioPayload = {
    from: billingClient.twilio_phone_number,
    to: destNumber,
    body: twilioBody,
    statusCallback: `${process.env.PORTAL_BASE_URL}/api/twilio?action=status`
  };
  if (hasMedia) twilioPayload.mediaUrl = [media_url];
  let twilioMsg;
  try {
    twilioMsg = await tw.messages.create(twilioPayload);
  } catch (err) {
    // Refund credits on hard failure (back to the billing client).
    await supabaseAdmin.rpc('add_credits', { p_client_id: billingId, p_amount: segments });
    await supabaseAdmin.from('credit_ledger').insert({
      client_id: billingId, delta: segments, reason: 'refund', ref_id: 'twilio_send_failed'
    });
    return res.status(502).json({ error: 'twilio_failed', detail: err.message });
  }

  // Persist message + ledger. Message rows stay with the originating
  // client (so Will sees his outbound texts in his Messages tab), but
  // the credit_ledger row is billed to the parent. media_url + is_mms
  // are stripped by insertMessageRow() if the migration hasn't landed.
  await insertMessageRow({
    client_id: clientId,
    contact_id: contact?.id || null,
    direction: 'outbound',
    body: text || '',
    segments,
    twilio_sid: twilioMsg.sid,
    status: twilioMsg.status,
    to_number: destNumber,
    from_number: billingClient.twilio_phone_number,
    credits_charged: segments,
    media_url: hasMedia ? media_url : null,
    is_mms: hasMedia
  });
  await supabaseAdmin.from('credit_ledger').insert({
    client_id: billingId, delta: -segments, reason: hasMedia ? 'mms_send' : 'sms_send', ref_id: twilioMsg.sid
  });

  // Auto-reload check — runs against the billing client so the parent's
  // top-up rules are what trigger when the shared pool drops.
  if (billingClient.auto_reload_enabled && newBal < billingClient.auto_reload_threshold) {
    try {
      await fetch(`${process.env.PORTAL_BASE_URL}/api/portal/credits?action=auto-reload-trigger`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal': process.env.SUPABASE_SERVICE_ROLE_KEY },
        body: JSON.stringify({ client_id: billingId })
      });
    } catch {}
  }

  return res.status(200).json({ ok: true, sid: twilioMsg.sid, balance: newBal, segments });
}
