// Server entry point. Deliberately empty of QU logic — it only wires the
// generic static server (server/static-server.mjs) to this repo's own
// directory, so that index.html, demo/, test/, and the docs viewer can be
// opened over http://localhost instead of file:// (which browsers block
// fetch() and strict ESM loading on for local files), and attaches a
// universal QU relay (relay/relay.mjs — no chat/app assumptions of its
// own) over a Node WebSocket bridge (relay/node-ws-bridge.mjs) to the same
// port. Persistence and which topics to relay are plain configuration
// values chosen here, for this specific deployment — the relay itself
// makes no assumption about either.
//
// Run: node index.js   (or: npm start)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/static-server.mjs';
import { createTestRoutes } from './server/test-runner.mjs';
import { createPushRoutes } from './server/push-routes.mjs';
import { createWebRTCRoutes } from './server/webrtc-routes.mjs';
import { createPortalRoutes } from './server/portal-routes.mjs';
import { createRelay } from './relay/relay.mjs';
import { bridgeWebSocketServer } from './relay/node-ws-bridge.mjs';
import { createPersistedMap } from './relay/persisted-map.mjs';
import { sendWebPush, generateVapidKeys } from './relay/webpush.mjs';
import { QuStore, MemoryAdapter, MemoryFileStorageAdapter, NullAdapter, enableConsoleDebug, createRateLimiter } from './src/index.js';
import { FileSystemStorageAdapter } from './src/adapters/node-fs.js';
import { FileSystemFileStorageAdapter } from './src/adapters/node-fs-file-storage.js';

// Last-resort safety net. Every known instance of "an async listener's
// rejection goes uncaught" has been fixed at its source (Channel dispatch,
// Core's subscription engine, Session.on()) — but a long-running relay
// process should never die from a bug class we haven't found a fourth
// instance of yet. This does not replace fixing things properly; it's the
// floor under it, so a mistake degrades to a logged error, not a full
// outage for every connected client.
process.on('uncaughtException', (e) => {
  console.error('[Relay] uncaught exception (process kept alive):', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[Relay] unhandled rejection (process kept alive):', e);
});

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT) || 8787;
const dataDir = path.join(root, '.relay-data');

// Debug output for the relay — every ingest, push, sync, and file-transfer
// event, until someone actually needs to look. Set QU_DEBUG=0 to silence.
if (process.env.QU_DEBUG !== '0') {
  const filter = process.env.QU_DEBUG_SCOPE ? process.env.QU_DEBUG_SCOPE.split(',') : null;
  enableConsoleDebug({ filter });
}

// Two supported startup modes, chosen once at process start — flüchtig
// (in-memory, gone on restart, no disk I/O at all: quick local testing,
// ephemeral relay instances) or persistent (the default: a durable,
// file-backed mirror that survives a restart). `QU_STORE=memory` to opt
// into the former; anything else (including unset) keeps the previous,
// always-persistent default so existing deployments see no behavior change.
const persistent = process.env.QU_STORE !== 'memory';

/** Loads an existing `{ publicKey, privateKey }` from `filePath`, or generates + saves a fresh one on first run. Used only in persistent mode — see the VAPID block below for why memory mode skips this entirely. */
function loadOrGenerateVapidKeys(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    const keys = generateVapidKeys();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(keys));
    return keys;
  }
}

// Web Push (relay/webpush.mjs) — ON by default, no setup required: unless
// QU_VAPID_PUBLIC_KEY/QU_VAPID_PRIVATE_KEY are explicitly set, a keypair is
// generated on first run and saved to `.relay-data/vapid-keys.json` (same
// idea as the relay's own identity/the qubit store — this deployment
// persists what it needs to keep working across a restart, without a
// manual setup step). `QU_PUSH=0` opts out entirely (no keys generated,
// `/push/vapid-public-key` reports `null`, examples/chat/app.mjs's
// "Aktivieren" button disables itself). In `QU_STORE=memory` mode, an
// AUTO-generated pair is kept in-memory-only and regenerated every
// restart, matching that mode's own "no disk I/O at all" contract —
// pass explicit env vars instead if you want stable push across restarts
// of an otherwise-ephemeral relay. Rotating the keypair (any way it
// happens) invalidates every subscription a browser already holds.
const pushDisabled = process.env.QU_PUSH === '0';
let vapidPublicKey = process.env.QU_VAPID_PUBLIC_KEY || null;
let vapidPrivateKey = process.env.QU_VAPID_PRIVATE_KEY || null;
if (process.env.QU_VAPID_PUBLIC_KEY && !process.env.QU_VAPID_PRIVATE_KEY) {
  console.warn('[Relay] QU_VAPID_PUBLIC_KEY is set but QU_VAPID_PRIVATE_KEY is missing — ignoring both and auto-generating a fresh pair instead.');
  vapidPublicKey = null;
}
if (!pushDisabled && !(vapidPublicKey && vapidPrivateKey)) {
  const keys = persistent ? loadOrGenerateVapidKeys(path.join(dataDir, 'vapid-keys.json')) : generateVapidKeys();
  vapidPublicKey = keys.publicKey;
  vapidPrivateKey = keys.privateKey;
}
const vapidSubject = process.env.QU_VAPID_SUBJECT || 'mailto:admin@example.com';
const pushEnabled = !pushDisabled && !!(vapidPublicKey && vapidPrivateKey);
const sendPush = pushEnabled
  ? ({ subscription, payload }) => sendWebPush({ subscription, payload, vapidKeys: { publicKey: vapidPublicKey, privateKey: vapidPrivateKey }, subject: vapidSubject })
  : null;

// WebRTC calling (examples/chat) works with just a public STUN server
// (src/network/transports/webrtc-browser.js's DEFAULT_ICE_SERVERS) ONLY
// when at least one side is directly reachable or STUN-reflexive-reachable
// — plenty of real networks (mobile carrier-grade NAT, symmetric NAT,
// restrictive firewalls) need a TURN relay instead, and unlike STUN there
// is no free public TURN service (relaying media costs real bandwidth), so
// this has to be an explicit opt-in: QU_TURN_URLS (comma-separated, e.g.
// "turn:turn.example.com:3478,turns:turn.example.com:5349"),
// QU_TURN_USERNAME, QU_TURN_CREDENTIAL. Unset by default — calls between
// peers that can't reach each other directly will fail to connect, same
// as before this existed.
// More than one STUN server, not just Cloudflare's — a single provider's
// STUN server can be unreachable for reasons that have nothing to do with
// this deployment (its own outage, a route/DNS issue specific to one
// peer's network, IPv6 binding failures seen in the wild against exactly
// this server). Listing several public ones costs nothing (a peer only
// ever needs ONE to succeed to learn its own reflexive address) and turns
// "one provider having a bad day" from a hard call failure into "still
// works, just gathers candidates from a different server".
const turnUrls = (process.env.QU_TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const iceServers = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...(turnUrls.length ? [{ urls: turnUrls, username: process.env.QU_TURN_USERNAME || '', credential: process.env.QU_TURN_CREDENTIAL || '' }] : []),
];

// /test/manifest.json is always on (read-only, no code runs); the
// server-side test-EXECUTION endpoint (/test/run-node-tests) is opt-in via
// QU_ENABLE_TEST_ENDPOINT=1 — see server/test-runner.mjs for why.
const server = startServer({
  root, port,
  routes: [
    ...createTestRoutes({ root }),
    ...createPushRoutes({ publicKey: pushEnabled ? vapidPublicKey : null }),
    ...createWebRTCRoutes({ iceServers }),
    ...createPortalRoutes({ root }),
  ],
});

const store = new QuStore([
  { prefix: '', adapter: persistent ? new FileSystemStorageAdapter(path.join(dataDir, 'qubits.ndjson')) : new MemoryAdapter() },
  { prefix: 'signal/', adapter: new NullAdapter() },
  // `push-subscription/<fp>` (relay.mjs's sendPush hook + examples/chat/
  // app.mjs): processed live (verify+ACL+dispatch run normally, see
  // NullAdapter's own doc comment), never persisted as a QuBit, never
  // forwarded to another peer (`replicate: false` — network/replication/
  // default.js's isReplicable() check). `pushSubscriptions` below is
  // relay.mjs's OWN, separate durability for what it needs to remember.
  { prefix: 'push-subscription/', adapter: new NullAdapter(), replicate: false },
]);
const fileStorage = persistent ? new FileSystemFileStorageAdapter(path.join(dataDir, 'files')) : new MemoryFileStorageAdapter();

// A push subscription must outlive a relay restart (that's the entire
// point of push, unlike a live WS connection) — persisted alongside
// qubits/files above under the same `QU_STORE=memory` switch, or kept
// in-memory-only for a quick ephemeral relay (relay/persisted-map.mjs).
const pushSubscriptions = persistent
  ? createPersistedMap(path.join(dataDir, 'push-subscriptions.json'))
  : new Map();

// Incoming-push protection (network/replication/default.js). Rate limiting
// is ON by default with a generous per-fingerprint budget — unlike
// QU_ENABLE_TEST_ENDPOINT (opt-in because it triggers real work per
// request), an unprotected `ingest()` from any reachable client is the
// actual risk here, so the safe default is "on", not "off". `QU_RATE_LIMIT=0`
// disables it entirely (e.g. for trusted-only/offline test setups);
// `QU_RATE_LIMIT_MAX`/`QU_RATE_LIMIT_WINDOW_MS` tune it.
// `QU_REQUIRE_DIRECT_WRITER=1` opts into the stricter star-topology check
// (rejects any push whose signer isn't the connection it arrived on) — off
// by default, because it's a topology decision a deployment must choose
// deliberately (it would break a legitimate client relaying what it
// learned from a WebRTC peer onward to this relay).
const rateLimitMax = Number(process.env.QU_RATE_LIMIT_MAX) || 200;
const rateLimiter = process.env.QU_RATE_LIMIT === '0' ? null : createRateLimiter({
  maxPerWindow: rateLimitMax,
  windowMs: Number(process.env.QU_RATE_LIMIT_WINDOW_MS) || 1000,
});
const requireDirectWriter = process.env.QU_REQUIRE_DIRECT_WRITER === '1';

// allowDynamicSubscribe: true — on top of the static 'qu-demo-room/' below
// (kept for docs/lab/'s Network section, which relies on a fixed room), any
// connected client may additionally register its own topic at runtime via
// qu.subscribe() (network/replication/default.js) — what the Playground's
// "Bob" step and examples/app-space-lib.mjs's runtime-created App-Spaces
// rely on. Still fully ACL-gated per push, never a wider grant than the
// static case (README "Sync, Mirror, Relay").
const relayApi = await createRelay({ store, fileStorage, pushTopics: ['qu-demo-room/'], allowDynamicSubscribe: true, requireDirectWriter, rateLimiter, sendPush, pushSubscriptions });
bridgeWebSocketServer(server, relayApi, { path: '/relay' });
console.log(pushEnabled
  ? `[Relay] Web Push enabled (${pushSubscriptions.size} stored subscription(s))`
  : '[Relay] Web Push disabled (QU_PUSH=0)');
