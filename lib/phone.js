// Convert a phone number to E.164 (the format Twilio requires for the `to`
// parameter — e.g. "+15572196896"). Strings that are already E.164 pass
// through unchanged; bare 10-digit US numbers get a +1 prefix.
//
// Returns null when the input can't be coerced into a valid E.164 number,
// so callers must guard against that before sending.

export function toE164(phone, defaultCountry = 'US') {
  if (!phone) return null;
  const raw = String(phone).trim();

  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
  }

  // International access prefix (00 → +).
  if (raw.startsWith('00')) {
    const digits = raw.slice(2).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? '+' + digits : null;
  }

  const digits = raw.replace(/\D/g, '');
  if (defaultCountry === 'US') {
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  }
  // Anything else with a plausible international length — assume it
  // already includes a country code and the user just dropped the +.
  if (digits.length >= 11 && digits.length <= 15) return '+' + digits;
  return null;
}
