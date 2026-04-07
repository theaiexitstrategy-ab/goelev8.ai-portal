import { supabaseAdmin } from '../../lib/supabase.js';

async function parseForm(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return Object.fromEntries(new URLSearchParams(raw));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const p = await parseForm(req);
  const sid = p.MessageSid;
  const status = p.MessageStatus;
  const errorCode = p.ErrorCode || null;
  if (sid) {
    await supabaseAdmin.from('messages')
      .update({ status, error_code: errorCode })
      .eq('twilio_sid', sid);
  }
  return res.status(200).end();
}
