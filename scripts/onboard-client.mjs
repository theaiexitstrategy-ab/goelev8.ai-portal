#!/usr/bin/env node
// Onboard a tenant end-to-end:
//   1. Create Stripe customer
//   2. (optional) Create Twilio subaccount + buy a phone number under it
//      and point its inbound + status webhooks at the portal
//   3. Insert clients row + Supabase auth users + client_users links
//
// Usage:
//   # Existing presets (parent-account numbers, no subaccount)
//   node scripts/onboard-client.mjs --preset flex-facility
//   node scripts/onboard-client.mjs --preset islay-studios
//
//   # New tenant with isolated Twilio subaccount + auto-purchased number
//   node scripts/onboard-client.mjs \
//     --name "Acme Co" --slug acme \
//     --email owner@acme.com --password "Acme123!!" \
//     --subaccount --area-code 415
//
//   # New tenant, manually specify a number you already own (will be
//   # transferred from the parent account into the new subaccount):
//   node scripts/onboard-client.mjs \
//     --name "Acme Co" --slug acme --email owner@acme.com \
//     --password "Acme123!!" --subaccount --transfer-number +14155551234
//
//   # New tenant on parent account (legacy mode):
//   node scripts/onboard-client.mjs --name "Acme Co" --slug acme \
//     --email owner@acme.com --password "Acme123!!" --phone +14155551234

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import Twilio from 'twilio';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const parentTwilio = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const base = process.env.PORTAL_BASE_URL || 'https://portal.goelev8.ai';

const PRESETS = {
  'flex-facility': {
    name: 'The Flex Facility', slug: 'flex-facility',
    twilio_phone_number: '+18775153539',
    password: 'Flex123!!!',
    users: ['ab@theflexfacility.com', 'kenny@theflexfacility.com'],
    subaccount: false
  },
  'islay-studios': {
    name: 'iSlay Studios', slug: 'islay-studios',
    twilio_phone_number: '+18332787529',
    password: 'iSlay123!!!',
    users: ['ab@islaystudiosllc.com', 'nate@islaystudiosllc.com'],
    subaccount: false
  }
};

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return null;
  const next = process.argv[i + 1];
  return (!next || next.startsWith('--')) ? true : next;
}

const preset = arg('preset');
const cfg = preset ? PRESETS[preset] : {
  name: arg('name'),
  slug: arg('slug'),
  twilio_phone_number: arg('phone'),
  password: arg('password'),
  users: [arg('email')].filter(Boolean),
  subaccount: !!arg('subaccount'),
  area_code: arg('area-code'),
  toll_free: !!arg('toll-free'),
  transfer_number: arg('transfer-number')
};
if (!cfg?.name || !cfg.slug) {
  console.error('Missing required fields. Use --preset or --name/--slug/--email/--password');
  process.exit(1);
}

console.log(`→ Onboarding ${cfg.name}`);

// =====================================================================
// 1. Stripe customer
// =====================================================================
const customer = await stripe.customers.create({
  name: cfg.name,
  email: cfg.users[0],
  metadata: { slug: cfg.slug }
});
console.log('  ✓ Stripe customer:', customer.id);

// =====================================================================
// 2. Twilio: subaccount + number (when --subaccount flag is set)
// =====================================================================
let subAcctSid = null;
let subAcctToken = null;
let phoneNumber = cfg.twilio_phone_number || null;

if (cfg.subaccount) {
  console.log('  → Creating Twilio subaccount…');
  const sub = await parentTwilio.api.v2010.accounts.create({
    friendlyName: `GoElev8 — ${cfg.name}`
  });
  subAcctSid = sub.sid;
  subAcctToken = sub.authToken;
  console.log('  ✓ Subaccount:', subAcctSid);

  const subClient = Twilio(subAcctSid, subAcctToken);

  if (cfg.transfer_number) {
    // Transfer an existing parent-account number into the subaccount.
    const list = await parentTwilio.incomingPhoneNumbers.list({
      phoneNumber: cfg.transfer_number, limit: 5
    });
    const num = list[0];
    if (!num) {
      console.error(`  ✗ ${cfg.transfer_number} not found in parent account`);
      process.exit(1);
    }
    await parentTwilio.incomingPhoneNumbers(num.sid).update({ accountSid: subAcctSid });
    phoneNumber = cfg.transfer_number;
    console.log(`  ✓ Transferred ${phoneNumber} to subaccount`);

    // Re-fetch under the subaccount and configure webhooks
    const subList = await subClient.incomingPhoneNumbers.list({ phoneNumber, limit: 5 });
    if (subList[0]) {
      await subClient.incomingPhoneNumbers(subList[0].sid).update({
        smsUrl: `${base}/api/twilio?action=inbound`,
        smsMethod: 'POST',
        statusCallback: `${base}/api/twilio?action=status`,
        statusCallbackMethod: 'POST'
      });
      console.log('  ✓ Webhooks configured');
    }
  } else {
    // Search for an available number and buy it under the subaccount.
    const search = { limit: 1, smsEnabled: true };
    if (cfg.area_code && cfg.area_code !== true) search.areaCode = cfg.area_code;
    const pool = cfg.toll_free
      ? subClient.availablePhoneNumbers('US').tollFree
      : subClient.availablePhoneNumbers('US').local;
    console.log(`  → Searching available US ${cfg.toll_free ? 'toll-free' : 'local'} numbers${search.areaCode ? ' in ' + search.areaCode : ''}…`);
    const available = await pool.list(search);
    if (!available[0]) {
      console.error('  ✗ No numbers available with those criteria');
      process.exit(1);
    }
    const purchased = await subClient.incomingPhoneNumbers.create({
      phoneNumber: available[0].phoneNumber,
      smsUrl: `${base}/api/twilio?action=inbound`,
      smsMethod: 'POST',
      statusCallback: `${base}/api/twilio?action=status`,
      statusCallbackMethod: 'POST'
    });
    phoneNumber = purchased.phoneNumber;
    console.log('  ✓ Purchased + configured:', phoneNumber);
  }
} else if (cfg.twilio_phone_number) {
  // Parent account number — make sure webhooks are pointed at the portal
  try {
    const list = await parentTwilio.incomingPhoneNumbers.list({
      phoneNumber: cfg.twilio_phone_number, limit: 5
    });
    if (list[0]) {
      await parentTwilio.incomingPhoneNumbers(list[0].sid).update({
        smsUrl: `${base}/api/twilio?action=inbound`,
        smsMethod: 'POST',
        statusCallback: `${base}/api/twilio?action=status`,
        statusCallbackMethod: 'POST'
      });
      console.log(`  ✓ Webhooks configured on parent-account number ${cfg.twilio_phone_number}`);
    }
  } catch (e) {
    console.warn('  ! Could not auto-configure webhooks:', e.message);
  }
}

// =====================================================================
// 3. clients row
// =====================================================================
const clientPayload = {
  name: cfg.name,
  slug: cfg.slug,
  twilio_phone_number: phoneNumber,
  twilio_subaccount_sid: subAcctSid,
  twilio_auth_token: subAcctToken,
  stripe_customer_id: customer.id
};

const { data: existing } = await sb.from('clients').select('id').eq('slug', cfg.slug).maybeSingle();
let clientId;
if (existing) {
  clientId = existing.id;
  await sb.from('clients').update(clientPayload).eq('id', clientId);
  console.log('  ✓ Updated existing client row');
} else {
  const { data: c, error } = await sb.from('clients')
    .insert({ ...clientPayload, credit_balance: 20 })
    .select().single();
  if (error) { console.error(error); process.exit(1); }
  clientId = c.id;
  console.log('  ✓ Client row:', clientId, '(seeded with 20 free trial credits)');
  await sb.from('credit_ledger').insert({
    client_id: clientId, delta: 20, reason: 'trial_grant', ref_id: 'free_trial_20'
  });
}

// =====================================================================
// 4. Supabase auth users + client_users links
// =====================================================================
for (const email of cfg.users) {
  const { data: created, error } = await sb.auth.admin.createUser({
    email, password: cfg.password, email_confirm: true
  });
  let userId;
  if (error && /already/i.test(error.message)) {
    const { data: list } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    userId = list.users.find(u => u.email === email)?.id;
    if (userId) {
      await sb.auth.admin.updateUserById(userId, { password: cfg.password });
      console.log(`  ✓ User exists, password reset: ${email}`);
    }
  } else if (error) {
    console.error('  ✗ ' + email, error.message);
    continue;
  } else {
    userId = created.user.id;
    console.log(`  ✓ User created: ${email}`);
  }
  if (userId) {
    await sb.from('client_users').upsert({ user_id: userId, client_id: clientId, role: 'owner' });
  }
}

console.log(`\n🎉 ${cfg.name} ready`);
console.log(`   Login:    ${cfg.users[0]}`);
console.log(`   Password: ${cfg.password}`);
console.log(`   Number:   ${phoneNumber || '(none)'}`);
if (subAcctSid) console.log(`   Twilio subaccount: ${subAcctSid}`);
