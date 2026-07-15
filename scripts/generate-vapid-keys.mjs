// Prints a fresh VAPID keypair for Web Push (relay/webpush.mjs) — run once
// per deployment and keep the output stable: rotating these invalidates
// every push subscription a browser already holds (see index.js's
// QU_VAPID_PUBLIC_KEY/QU_VAPID_PRIVATE_KEY).
//
// Run: node scripts/generate-vapid-keys.mjs

import { generateVapidKeys } from '../relay/webpush.mjs';

const { publicKey, privateKey } = generateVapidKeys();
console.log('QU_VAPID_PUBLIC_KEY=' + publicKey);
console.log('QU_VAPID_PRIVATE_KEY=' + privateKey);
console.log('QU_VAPID_SUBJECT=mailto:you@example.com  # required by RFC 8292 — a contact address push services may use to reach you about abuse');
