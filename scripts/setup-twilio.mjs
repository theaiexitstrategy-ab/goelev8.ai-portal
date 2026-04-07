#!/usr/bin/env node
// Points both portal phone numbers' inbound + status webhooks at the portal.
import 'dotenv/config';
import Twilio from 'twilio';

const twilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const base = process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai';

const NUMBERS = [
  '+18775153539',  // Flex Facility
  '+18332787529'   // iSlay Studios
];

const list = await twilio.incomingPhoneNumbers.list({ limit: 200 });
for (const target of NUMBERS) {
  const num = list.find(n => n.phoneNumber === target);
  if (!num) {
    console.log(`✗ ${target} not found in account`);
    continue;
  }
  await twilio.incomingPhoneNumbers(num.sid).update({
    smsUrl: `${base}/api/twilio?action=inbound`,
    smsMethod: 'POST',
    statusCallback: `${base}/api/twilio?action=status`,
    statusCallbackMethod: 'POST'
  });
  console.log(`✓ ${target} → webhooks updated`);
}
console.log('Done.');
