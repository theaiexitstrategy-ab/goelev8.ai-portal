#!/usr/bin/env node
// Generate VAPID keys for web push notifications.
// Run once:  node scripts/generate-vapid-keys.js
// Then add the output to your .env.local and Vercel env vars.

import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('\n=== VAPID Keys Generated ===\n');
console.log('Add these to .env.local and Vercel Environment Variables:\n');
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(`VAPID_EMAIL=mailto:support@goelev8.ai`);
console.log('\nThe public key is safe to expose to the browser.');
console.log('The private key must be kept secret (server-side only).\n');
