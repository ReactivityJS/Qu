// QUniverse's own relay deployment — composes Qu's generic, app-agnostic
// relay (qu-core/relay/relay.mjs) with THIS ecosystem's concrete
// configuration (admins, rate/connection limits, the actual app catalog).
// Mirrors qu-core's own index.js bootstrap (env var names match on purpose,
// so existing deployment docs/tooling for a Qu relay apply unchanged), but
// trimmed to just the relay + service catalog — no docs/examples static
// server, no test-runner endpoint, none of which belongs to a product
// deployment.
//
// Phase 0 scope: this boots a working relay with a service catalog. The
// actual ecosystem shell (welcome page, nav dropdown, notification feed,
// router) is a later phase — see the architecture doc in Qu's own repo,
// branch claude/quniverse-ecosystem-architecture-cd289p.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QuIdentity, QuStore, MemoryAdapter, NullAdapter, MemoryFileStorageAdapter,
  isValidFingerprint, createRateLimiter, createConnectionGate, enableConsoleDebug,
  createNotificationPushRule,
} from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { bridgeWebSocketServer } from '../relay/node-ws-bridge.mjs';
import { generateVapidKeys, sendWebPush } from '../relay/webpush.mjs';
import { startServer } from '../server/static-server.mjs';
import { createRelayInfoRoutes } from '../server/relay-info-routes.mjs';
import { createPushRoutes } from '../server/push-routes.mjs';
import { createServiceRegistry } from '../server/service-registry.mjs';
import { createPlatformRegistry } from '../server/platform-registry.mjs';

// Serves the WHOLE Qu repo root (one level up from this file's own
// directory), not just quniverse/ itself — this is what lets every relative
// `../src/...`/`../relay/...` import above resolve as real files over HTTP
// too (index.html/app.mjs/shell/*.mjs run in the browser, same static
// server). QUniverse's own pages are therefore reachable under `/quniverse/`
// (see README.md), not at origin root — see sw.js's registration path below.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT) || 8788;

if (process.env.QU_DEBUG === '1') enableConsoleDebug();

// Same comma-list-with-quote-stripping convention as qu-core's own
// index.js (QU_RELAY_ADMINS/QU_ALLOWED_FINGERPRINTS parsing there) —
// duplicated here rather than imported, since it's a few lines of
// deployment-script logic, not a reusable library function.
const QUOTE_RE = /^['"]|['"]$/g;
function parseFingerprintList(envVar, label) {
  const list = (process.env[envVar] || '')
    .split(',')
    .map((s) => s.trim().replace(QUOTE_RE, '').trim().toLowerCase())
    .filter(Boolean);
  for (const fp of list) {
    if (!isValidFingerprint(fp)) {
      console.warn(`[QUniverse] ${envVar} entry "${fp}" doesn't look like a valid fingerprint (expected 24 hex characters) — check for stray quotes/whitespace.`);
    }
  }
  return list;
}

const relayAdmins = parseFingerprintList('QU_RELAY_ADMINS', 'admins');

const rateLimiter = process.env.QU_RATE_LIMIT === '0' ? null : createRateLimiter({
  maxPerWindow: Number(process.env.QU_RATE_LIMIT_MAX) || 200,
  windowMs: Number(process.env.QU_RATE_LIMIT_WINDOW_MS) || 1000,
});

const maxConnectionsEnv = process.env.QU_MAX_CONNECTIONS ? Number(process.env.QU_MAX_CONNECTIONS) : null;
const allowedFingerprintsEnv = parseFingerprintList('QU_ALLOWED_FINGERPRINTS', 'allowlist');
const connectionGate = (maxConnectionsEnv != null || allowedFingerprintsEnv.length)
  ? createConnectionGate({ maxConnections: maxConnectionsEnv, allowedFingerprints: allowedFingerprintsEnv.length ? allowedFingerprintsEnv : null })
  : null;

// THIS ecosystem's concrete app catalog — one entry per app under
// `services/<id>/`, following the App-/Service-Template (services/README.md).
// Empty for now: no real QUniverse-native app exists yet (Phase 4 migrates
// the first ones in) — each with its own manifest.mjs (server/service-
// registry.mjs's QUniverse App Manifest fields — icon, spaceMode,
// notificationTopics, …). Phase 1's shell/nav-dropdown/router was verified
// end-to-end against a TEMPORARY entry pointing at Qu's own already-running
// example app (cross-origin), then reverted — see the Phase 1 plan's own
// verification section for why that stayed out of the committed catalog.
const registry = createServiceRegistry([
  // { id: 'forum', category: 'service', label: 'Forum', entry: '/services/forum/index.html', icon: '💬', spaceMode: 'perInstance' },
]);

// Optional PLATFORM features (contacts, CMS-homepage, notification
// aggregation, directory, incognito) — separate from the app catalog above:
// this toggles which pieces of the ecosystem SHELL itself a deployment
// wants active, administered the same way (admin/config/platform-modules,
// examples/relay-admin's own panel in qu-core). All enabled by default;
// QU_PLATFORM_MODULES_DISABLED narrows it at startup, same convention as
// qu-core's own index.js. The shell doesn't read this yet (no real
// feature screens exist to gate — see qu-core's own platform-registry.mjs
// commit message for why that's deliberately deferred), but the toggle
// mechanism itself is live from day one, same as the (currently empty)
// service catalog above.
const platformRegistry = createPlatformRegistry();
for (const id of (process.env.QU_PLATFORM_MODULES_DISABLED || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  platformRegistry.setEnabled(id, false);
}

// Web Push (qu-core/relay/webpush.mjs) — ON by default, no setup required:
// unless QU_VAPID_PUBLIC_KEY/QU_VAPID_PRIVATE_KEY are explicitly set, a
// fresh keypair is generated on every start. This deployment is still
// fully ephemeral/in-memory (see relayIdentity's own "pin a persisted
// identity" comment below) — VAPID keys share that same limitation for
// now: every restart invalidates every subscription a browser already
// holds, until BOTH the relay identity and these keys get a real
// persisted store, same as qu-core's own index.js documents for its
// QU_STORE=memory mode. `QU_PUSH=0` opts out entirely (no keys generated,
// `/push/vapid-public-key` reports `null`, src/ui/push.mjs's
// subscribeToPush() throws instead of silently doing nothing).
const pushDisabled = process.env.QU_PUSH === '0';
let vapidPublicKey = process.env.QU_VAPID_PUBLIC_KEY || null;
let vapidPrivateKey = process.env.QU_VAPID_PRIVATE_KEY || null;
if (process.env.QU_VAPID_PUBLIC_KEY && !process.env.QU_VAPID_PRIVATE_KEY) {
  console.warn('[QUniverse] QU_VAPID_PUBLIC_KEY is set but QU_VAPID_PRIVATE_KEY is missing — ignoring both and auto-generating a fresh pair instead.');
  vapidPublicKey = null;
}
if (!pushDisabled && !(vapidPublicKey && vapidPrivateKey)) {
  const keys = generateVapidKeys();
  vapidPublicKey = keys.publicKey;
  vapidPrivateKey = keys.privateKey;
}
const vapidSubject = process.env.QU_VAPID_SUBJECT || 'mailto:admin@example.com';
const pushEnabled = !pushDisabled && !!(vapidPublicKey && vapidPrivateKey);
const sendPush = pushEnabled
  ? ({ subscription, payload }) => sendWebPush({ subscription, payload, vapidKeys: { publicKey: vapidPublicKey, privateKey: vapidPrivateKey }, subject: vapidSubject })
  : null;
const pushSubscriptions = new Map();
// createNotificationPushRule() (qu-core/src/modules/notifications.js) —
// THE platform-level "services hook in easily" mechanism: any app calling
// qu.notifyUser() gets push-enabled automatically, no per-app rule or
// relay-side change needed. A real service adding its OWN push-worthy
// event type (e.g. a Forum reply) still just calls qu.notifyUser() rather
// than needing its own createXPushRule() — that escape hatch (relay.mjs's
// pushRules array) stays available for an app with a genuinely different
// need, but isn't required for the common case this array starts with.
const pushRules = [createNotificationPushRule()];

const relayIdentity = await QuIdentity.generate(); // ephemeral for now — pin a persisted identity (see qu-core's own index.js) before a real deployment

let relayApi;

const server = startServer({
  root, port,
  routes: [
    ...createRelayInfoRoutes({
      fingerprint: relayIdentity.fingerprint,
      epub: await crypto.subtle.exportKey('jwk', relayIdentity.encryptionKey),
      admins: relayAdmins,
      getAdminConfig: () => relayApi?.getAdminConfig?.() ?? null,
    }),
    ...createPushRoutes({ publicKey: pushEnabled ? vapidPublicKey : null }),
    {
      match: (p) => p === '/relay/services',
      handle: (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(registry.toJSON()));
      },
    },
  ],
});

const store = new QuStore([
  { prefix: '', adapter: new MemoryAdapter() }, // swap for a durable adapter (e.g. qu-core/src/adapters/node-fs.js's FileSystemStorageAdapter) before a real deployment
  { prefix: 'signal/', adapter: new NullAdapter() },
  { prefix: 'admin/', adapter: new NullAdapter(), replicate: false },
  // A push subscription is ephemeral control-plane data (this deployment's
  // OWN copy of what the browser's push service already holds), not
  // content worth persisting/forwarding to other peers — same NullAdapter/
  // replicate:false treatment as admin/ above, mirroring qu-core's own
  // index.js and test/relay-push.test.mjs's store setup for this exact
  // prefix.
  { prefix: 'push-subscription/', adapter: new NullAdapter(), replicate: false },
]);

relayApi = await createRelay({
  store,
  fileStorage: new MemoryFileStorageAdapter(),
  identity: relayIdentity,
  allowDynamicSubscribe: true, // apps mint their own Space ids at runtime (qu.createSpace()) — see qu-core's README on allowDynamicSubscribe
  rateLimiter,
  connectionGate,
  relayAdmins,
  serviceRegistry: registry,
  platformRegistry,
  sendPush,
  pushSubscriptions,
  pushRules,
});
await relayApi.relay.publishProfile();
bridgeWebSocketServer(server, relayApi, { path: '/relay' });

console.log(`[QUniverse] Relay listening on ws://localhost:${port}/relay (fingerprint: ${relayIdentity.fingerprint})`);
console.log(relayAdmins.length
  ? `[QUniverse] Admin fingerprints configured (${relayAdmins.length}): ${relayAdmins.join(', ')}`
  : '[QUniverse] No QU_RELAY_ADMINS configured — no admin write access to relay-services/ or admin/');
console.log(pushEnabled
  ? '[QUniverse] Web Push enabled (ephemeral keys unless QU_VAPID_PUBLIC_KEY/QU_VAPID_PRIVATE_KEY are set)'
  : '[QUniverse] Web Push disabled (QU_PUSH=0)');
