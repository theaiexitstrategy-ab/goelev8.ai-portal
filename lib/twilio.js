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

// Flat credit cost for an MMS (image attached) message. Twilio bills
// MMS as a single message regardless of body length (up to 5000 chars);
// there's no segment math like SMS. At ~$0.02/message Twilio cost, 3
// credits per MMS (~$0.12 at 4¢/credit) keeps the same margin band as
// segmented SMS while covering the higher per-message base rate.
//
// Used by both /api/portal/messages (1-on-1 send) and /api/portal/blasts
// (per-recipient) so an image-attached send costs 3 credits regardless
// of the body length.
export const MMS_CREDIT_COST = 3;

// Return the credit cost for a send given whether media is attached.
// Text-only → segment count (1 per 160 chars GSM-7). Media attached →
// flat MMS_CREDIT_COST. Callers should use this instead of calling
// estimateSegments() directly when a mediaUrl may be present.
export function creditsForSend(body, hasMedia) {
  if (hasMedia) return MMS_CREDIT_COST;
  return estimateSegments(body || '');
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

// Hard cap on outbound SMS length. Every call site below this comment
// passes its body through truncateForSms() before handing it to
// twilio.messages.create(). 160 = single GSM-7 segment limit, which
// is the platform-wide policy for outbound SMS regardless of
// encoding.
export const SMS_MAX_CHARS = 160;

// Truncate an outbound SMS body to <= SMS_MAX_CHARS without cutting
// a word in half. Returns the (possibly trimmed) string verbatim:
// no ellipsis, no marker, no truncation indicator — the recipient
// cannot tell the message was clipped. Logs the original + truncated
// lengths to the server console for internal diagnostics only.
//
// Algorithm:
//   1. If the body already fits, return it unchanged.
//   2. Otherwise look at the character at position SMS_MAX_CHARS. If
//      it's whitespace (or past end of string), we can cut cleanly
//      at SMS_MAX_CHARS — the boundary already falls between words.
//   3. If the boundary lands mid-word, scan backward through the
//      first SMS_MAX_CHARS characters for the last whitespace and
//      cut there.
//   4. Pathological case: if there is no whitespace anywhere in the
//      first SMS_MAX_CHARS characters (one giant unbroken word), we
//      fall back to a hard cut at SMS_MAX_CHARS to honor the limit.
//   5. Strip any trailing whitespace off the cut so we don't ship a
//      message ending in a dangling space/newline.
export function truncateForSms(body) {
  const orig = String(body == null ? '' : body);
  if (orig.length <= SMS_MAX_CHARS) return orig;
  const boundaryChar = orig.charAt(SMS_MAX_CHARS);
  let cut;
  if (boundaryChar === '' || /\s/.test(boundaryChar)) {
    cut = SMS_MAX_CHARS;
  } else {
    let i = SMS_MAX_CHARS - 1;
    while (i >= 0 && !/\s/.test(orig.charAt(i))) i--;
    cut = i >= 0 ? i : SMS_MAX_CHARS;
  }
  const truncated = orig.slice(0, cut).replace(/\s+$/, '');
  console.log(`[sms-truncate] original=${orig.length} truncated=${truncated.length}`);
  return truncated;
}
