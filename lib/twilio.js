import Twilio from 'twilio';

// Parent (master) account client — used for subaccount management,
// inbound webhooks (still resolved by destination number), and as a
// fallback when a client has no subaccount yet.
export const twilio = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Returns a Twilio client scoped to a specific tenant. If the tenant
// has its own subaccount, requests are billed/isolated to that subaccount;
// otherwise we fall back to the parent account.
export function twilioForClient(client) {
  if (client?.twilio_subaccount_sid && client?.twilio_auth_token) {
    return Twilio(client.twilio_subaccount_sid, client.twilio_auth_token);
  }
  return twilio;
}

// Estimate SMS segment count (GSM-7 vs UCS-2). 1 segment = 1 credit.
export function estimateSegments(body = '') {
  const isUnicode = /[^\u0000-\u007f]/.test(body);
  const len = body.length;
  if (isUnicode) {
    if (len <= 70) return 1;
    return Math.ceil(len / 67);
  }
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}
