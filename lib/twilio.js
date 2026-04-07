import Twilio from 'twilio';

export const twilio = Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
