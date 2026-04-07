#!/usr/bin/env node
// Creates a tenant: clients row, Supabase auth users, client_users links, Stripe Customer.
//
// Usage:
//   node scripts/onboard-client.mjs --preset flex-facility
//   node scripts/onboard-client.mjs --preset islay-studios
//   node scripts/onboard-client.mjs --name "Acme Co" --slug acme \
//        --phone +18001234567 --email owner@acme.com --password "Acme123!!"
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const PRESETS = {
  'flex-facility': {
    name: 'The Flex Facility',
    slug: 'flex-facility',
    twilio_phone_number: '+18775153539',
    password: 'Flex123!!!',
    users: ['ab@theflexfacility.com', 'kenny@theflexfacility.com']
  },
  'islay-studios': {
    name: 'iSlay Studios',
    slug: 'islay-studios',
    twilio_phone_number: '+18332787529',
    password: 'iSlay123!!!',
    users: ['ab@islaystudiosllc.com', 'nate@islaystudiosllc.com']
  }
};

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const preset = arg('preset');
const cfg = preset ? PRESETS[preset] : {
  name: arg('name'),
  slug: arg('slug'),
  twilio_phone_number: arg('phone'),
  password: arg('password'),
  users: [arg('email')].filter(Boolean)
};
if (!cfg?.name || !cfg.slug) {
  console.error('Missing required fields. Use --preset or --name/--slug/--phone/--email/--password');
  process.exit(1);
}

console.log(`→ Onboarding ${cfg.name}`);

// 1. Stripe customer
const customer = await stripe.customers.create({
  name: cfg.name,
  email: cfg.users[0],
  metadata: { slug: cfg.slug }
});
console.log('  ✓ Stripe customer:', customer.id);

// 2. Client row
const { data: existing } = await sb.from('clients').select('id').eq('slug', cfg.slug).maybeSingle();
let clientId;
if (existing) {
  clientId = existing.id;
  await sb.from('clients').update({
    name: cfg.name,
    twilio_phone_number: cfg.twilio_phone_number,
    stripe_customer_id: customer.id
  }).eq('id', clientId);
  console.log('  ✓ Updated existing client row');
} else {
  const { data: c, error } = await sb.from('clients').insert({
    name: cfg.name,
    slug: cfg.slug,
    twilio_phone_number: cfg.twilio_phone_number,
    stripe_customer_id: customer.id,
    credit_balance: 0
  }).select().single();
  if (error) { console.error(error); process.exit(1); }
  clientId = c.id;
  console.log('  ✓ Client row:', clientId);
}

// 3. Auth users + links
for (const email of cfg.users) {
  const { data: created, error } = await sb.auth.admin.createUser({
    email,
    password: cfg.password,
    email_confirm: true
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
console.log(`   Login: ${cfg.users[0]}`);
console.log(`   Password: ${cfg.password}`);
