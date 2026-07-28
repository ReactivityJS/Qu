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
import { createServiceRegistry } from './server/service-registry.mjs';
import { createPlatformRegistry } from './server/platform-registry.mjs';
import { createRelayInfoRoutes } from './server/relay-info-routes.mjs';
import { createRelay } from './relay/relay.mjs';
import { loadOrGenerateRelayIdentity } from './relay/relay-identity.mjs';
import { createFail2banService } from './relay/services/fail2ban.mjs';
import { bridgeWebSocketServer } from './relay/node-ws-bridge.mjs';
import { createPersistedMap } from './relay/persisted-map.mjs';
import { sendWebPush, generateVapidKeys } from './relay/webpush.mjs';
import {
  QuIdentity, QuStore, MemoryAdapter, MemoryFileStorageAdapter, NullAdapter, enableConsoleDebug, createRateLimiter, createConnectionGate, isValidFingerprint,
  createChatPushRule, createCalendarPushRule, createItemInvitePushRule,
} from './src/index.js';
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

// The Services/Examples/Documentation catalog (portal.mjs, server/
// portal-routes.mjs) — the single source of truth every consumer reads
// from, replacing what used to be two independently hand-maintained
// SERVICE_APPS objects (see server/service-registry.mjs's file doc for
// the full history). `entry`-only definitions here are the code-level
// "seed" catalog; an operator with a relayAdmins fingerprint can add
// FURTHER pure-data (link-only) entries at runtime, no restart, by
// publishing to `relay-services/<id>` (see relay/relay.mjs) — this array
// is not the only source once the relay is running, just the bootstrap
// one. QU_SERVICES_DISABLED (comma-separated ids) turns any of these off
// at startup, e.g. `QU_SERVICES_DISABLED=forum,hunt`.
const registry = createServiceRegistry([
  { id: 'chat', category: 'service', label: '💬 Messenger', description: 'Verschlüsselter 1:1- und Gruppen-Chat, Anrufe, Dateiübertragung — installierbar als PWA.', entry: '/examples/chat/index.html' },
  { id: 'people', category: 'service', label: '👥 People', description: 'Globales, opt-in Identitäten-Verzeichnis — ein Profil (Alias, Avatar, Zusatz-Attribute), wiederverwendbar über jede Qu-App hinweg.', entry: '/examples/people/index.html' },
  { id: 'forum', category: 'service', label: '🗂️ Forum', description: 'Themen mit Titel + Antworten auf einem geteilten Space.', entry: '/examples/forum/index.html' },
  { id: 'calendar', category: 'service', label: '📅 Kalender', description: 'Verschlüsselter, gemeinsam genutzter Kalender — Monats-/Wochen-/Tagesansicht, Einladung zum Kalender UND zu einzelnen Terminen, RSVP, Push-Benachrichtigungen.', entry: '/examples/calendar/index.html' },
  { id: 'cms', category: 'service', label: '📄 CMS', description: 'Seiten/Templates auf einem geteilten Space, mehrere Autoren.', entry: '/examples/cms/index.html' },
  { id: 'hunt', category: 'service', label: '🗺️ Hunt', description: 'Standort-basiertes Fang-Spiel auf einem geteilten Space.', entry: '/examples/hunt/index.html' },
  { id: 'example-modules', category: 'example', label: 'Beispiel-Module', description: 'Sechs kurze, fokussierte Module (ToDo-Liste, Forum, App-Space, Sub-Space-Index, Space-App-Basis, CMS-Erweiterung) — Logik getrennt von jeder Oberfläche, mit node --test nachvollziehbar.', entry: '/docs/examples.html' },
  { id: 'lab', category: 'example', label: 'Interaktives Lab', description: 'Core, Storage, Spaces/ACL, Netzwerk/Relay/Mirror — Schritt für Schritt im Browser, mit echten Objekten in der Konsole zum Weiterprobieren.', entry: '/docs/lab/index.html' },
  { id: 'playground', category: 'example', label: 'Playground', description: 'Eine fertig initialisierte qu-Instanz in der Konsole, dazu Copy-Paste-Beispiele für get/put/set/on/map, Spaces, Referenzen, Dateien und eine echte Relay-Verbindung.', entry: '/docs/playground.html' },
  { id: 'readme', category: 'documentation', label: 'README', description: 'Schnelleinstieg, Projektstruktur, Kernprinzipien.', entry: '/docs/view.html?file=/README.md' },
  { id: 'api', category: 'documentation', label: 'API-Referenz', description: 'Jede öffentliche Funktion/Klasse — Parameter, Rückgabewerte, Beispiele.', entry: '/docs/view.html?file=/API.md' },
  { id: 'app-guide', category: 'documentation', label: 'App-Guide', description: 'Eine vernetzte App bauen: mehrere Instanzen tauschen Daten über einen echten Relay und einen gemeinsamen App-Space aus.', entry: '/docs/view.html?file=/APP-GUIDE.md' },
  { id: 'whitepaper', category: 'documentation', label: 'Whitepaper', description: 'Architektur-Spezifikation — Contracts, Sicherheitsmodell, Spaces, Facade.', entry: '/docs/view.html?file=/qu-whitepaper-v0.6.md' },
  { id: 'tests', category: 'documentation', label: 'Tests', description: 'Dieselbe Testsuite wie npm test, hier im Browser ausgeführt.', entry: '/test/index.html' },
  // category: 'admin', not 'service' — portal.mjs only ever renders
  // 'service'/'example'/'documentation' cards, so this never appears in
  // the public Services tab. That's a discoverability choice, not a
  // security boundary: static file serving has no notion of "this
  // visitor's fingerprint" to gate on (identity only proves itself once
  // the app's own JS connects to the relay) — the actual authorization is
  // entirely the relayAdmins ACL check on the writes this app makes (see
  // relay/relay.mjs), same as any other Qu app. Hiding the tab only saves
  // a non-admin visitor a confusing detour into an app they can open but
  // can't do anything privileged in.
  { id: 'relay-admin', category: 'admin', label: 'Relay-Admin', description: 'Services verwalten (nur für QU_RELAY_ADMINS-Fingerprints).', entry: '/examples/relay-admin/index.html' },
  // Reference custom service (relay/services/fail2ban.mjs, see
  // server/service-registry.mjs's extension contract doc for the full
  // reasoning) — registered but OFF by default: this demo deployment
  // shouldn't silently start banning fingerprints without an operator
  // deliberately turning it on. Enable it either at startup
  // (QU_SERVICES_DISABLED does the opposite — remove 'fail2ban' from
  // that env var's list, or just don't rely on enabledByDefault and flip
  // it directly here) or live, via the same admin/service/fail2ban
  // toggle command every other code-defined service already supports —
  // no restart needed either way once QU_RELAY_ADMINS is configured.
  { ...createFail2banService(), enabledByDefault: false },
]);
for (const id of (process.env.QU_SERVICES_DISABLED || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  registry.setEnabled(id, false);
}

// The Platform-Feature registry (server/platform-registry.mjs — contacts,
// CMS-homepage, notification-aggregation, directory, incognito) — this
// demo deployment has no shell that reads it yet (that's QUniverse's job,
// a separate product built on top of this repo), but every relay carries
// one regardless so examples/relay-admin's platform-modules panel has a
// real registry to administer, same as rate-limit/connection-limit above.
// Same QU_SERVICES_DISABLED convention, its own env var:
// `QU_PLATFORM_MODULES_DISABLED=contacts,incognito`.
const platformRegistry = createPlatformRegistry();
for (const id of (process.env.QU_PLATFORM_MODULES_DISABLED || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  platformRegistry.setEnabled(id, false);
}

// Fingerprints allowed to administer this relay (currently: write the
// runtime-maintained service catalog, relay-services/<id> — see
// relay/relay.mjs's relayAdmins option). Empty/unset by default — no admin
// capability at all until an operator explicitly pins at least one
// fingerprint here.
// `.toLowerCase()` matters: a fingerprint is ALWAYS lowercase hex
// (core/identity.js's fingerprintOfPublicKey() builds it via
// `byte.toString(16)`, which never produces uppercase) — but a
// hand-typed or copy-pasted env var (a docker-compose.yml value, a
// clipboard that auto-capitalized, ...) can easily end up with different
// casing that LOOKS identical at a glance in a long hex string, and
// `acl.writers.includes(q.writer)` (core/acl.js) is a plain, case-
// SENSITIVE string comparison — a single differently-cased character
// silently makes every write from that admin fail, with no visual cue
// in a side-by-side comparison. Normalizing here costs nothing (a
// fingerprint is public, not a secret whose case ever needs preserving)
// and removes an entire class of "looks the same but isn't" bug reports.
//
// Stray leading/trailing `"`/`'` characters are stripped too — a real,
// reproduced case: a docker-compose.yml / Swarm-stack `environment` entry
// like `QU_RELAY_ADMINS="fp1, fp2"` can end up with the OUTER quote marks
// becoming part of the actual string value (YAML/Compose/Swarm quoting
// rules interact in a way that doesn't always strip them the way a shell
// would) — `.trim()` alone only removes whitespace, never a quote
// character, so the FIRST admin fingerprint silently became
// `"cf89ef5711f6efe9ba1bd504` (25 characters, leading quote) instead of
// the real 24-hex-character value, and every one of its writes was
// rejected by the ACL with no visual cue in the printed value (a quote
// character is easy to miss at the start of a long hex string,
// especially when copy-pasted rather than typed by hand).
const QUOTE_RE = /^['"]|['"]$/g;
const relayAdmins = (process.env.QU_RELAY_ADMINS || '')
  .split(',')
  .map((s) => s.trim().replace(QUOTE_RE, '').trim().toLowerCase()) // trim again after stripping quotes — a quote can itself be adjacent to whitespace the first trim() couldn't reach (e.g. `" fp"` — the leading quote hides the space behind it from the string's actual edge)
  .filter(Boolean);
// Catches BOTH the quoting mistake above (if a stray quote survives
// mid-string rather than only at an edge) and any other malformed entry
// (wrong length, non-hex characters, a fingerprint truncated by a copy-
// paste) — loud and at startup, not a silent ACL rejection an operator
// has to reverse-engineer from a rejected push later.
for (const fp of relayAdmins) {
  if (!isValidFingerprint(fp)) {
    console.warn(`[Relay] QU_RELAY_ADMINS entry "${fp}" doesn't look like a valid fingerprint (expected 24 hex characters) — it will never match any writer, check for stray quotes/whitespace in your environment configuration.`);
  }
}

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

// A relay that regenerates a fresh identity every restart has no stable
// fingerprint anything can address it by (an admin encrypting a command
// "only this relay can read", a peer that pinned it once via trustPeer())
// — persisted the same way the VAPID keypair above already is, and only
// in persistent mode for the same reason (see relay-identity.mjs's own
// doc comment). In memory mode a fresh identity is generated here too
// (not left to createRelay()'s own default) specifically so its
// fingerprint/epub are known BEFORE `startServer()` below builds
// /relay/info — a real deployment loses admin-encryption stability across
// restarts in memory mode either way, but a single run still gets a
// working, self-consistent relay-admin flow.
const relayIdentity = persistent
  ? await loadOrGenerateRelayIdentity(path.join(dataDir, 'relay-identity.json'))
  : await QuIdentity.generate();
const relayEpub = await crypto.subtle.exportKey('jwk', relayIdentity.encryptionKey);

// Declared here (assigned after createRelay() below, once its return value
// exists) so createRelayInfoRoutes()'s `getAdminConfig` closure can read
// the CURRENT relayApi at request time — routes are built once, at server
// startup, before createRelay() runs (it needs `store`, built further
// below), but a route handler only ever runs later, once a request
// actually arrives, well after this variable is assigned.
let relayApi;

// /test/manifest.json is always on (read-only, no code runs); the
// server-side test-EXECUTION endpoint (/test/run-node-tests) is opt-in via
// QU_ENABLE_TEST_ENDPOINT=1 — see server/test-runner.mjs for why.
const server = startServer({
  root, port,
  routes: [
    ...createTestRoutes({ root }),
    ...createPushRoutes({ publicKey: pushEnabled ? vapidPublicKey : null }),
    ...createWebRTCRoutes({ iceServers }),
    ...createPortalRoutes({ root, registry }),
    ...createRelayInfoRoutes({ fingerprint: relayIdentity.fingerprint, epub: relayEpub, admins: relayAdmins, getAdminConfig: () => relayApi?.getAdminConfig?.() ?? null }),
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
  // `admin/<...>` (relay/relay.mjs's admin-command listener): signed+
  // encrypted admin commands (e.g. toggling a code-defined service) —
  // processed live, never persisted, never forwarded to another peer.
  // Same reasoning/mechanism as push-subscription/ above, just for a
  // different reserved prefix.
  { prefix: 'admin/', adapter: new NullAdapter(), replicate: false },
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

// Connection-limit (network/connection-gate.js) — off by default (`null`
// gate = unlimited), same "explicit opt-in for a deployment decision"
// reasoning as requireDirectWriter above rather than a default-on
// protection like rateLimiter: capping WHO/HOW MANY may even hold an open
// connection is a much coarser, more consequential choice (a misconfigured
// allowlist locks out every real user, not just a flooding one) than a
// generous default rate-limit window. `QU_MAX_CONNECTIONS` — a ceiling on
// simultaneously connected fingerprints; `QU_ALLOWED_FINGERPRINTS` — same
// comma-list-with-quote-stripping convention as QU_RELAY_ADMINS above, an
// allowlist of the only fingerprints permitted to connect at all. Either
// (or both) present is enough to install the gate; both absent leaves
// connections exactly as unlimited as before this option existed. Both are
// also live-reconfigurable afterward via a signed admin/config/connection-limit
// command (relay/relay.mjs), without a restart.
const maxConnectionsEnv = process.env.QU_MAX_CONNECTIONS ? Number(process.env.QU_MAX_CONNECTIONS) : null;
const allowedFingerprintsEnv = (process.env.QU_ALLOWED_FINGERPRINTS || '')
  .split(',')
  .map((s) => s.trim().replace(QUOTE_RE, '').trim().toLowerCase())
  .filter(Boolean);
for (const fp of allowedFingerprintsEnv) {
  if (!isValidFingerprint(fp)) {
    console.warn(`[Relay] QU_ALLOWED_FINGERPRINTS entry "${fp}" doesn't look like a valid fingerprint (expected 24 hex characters) — it will never match any connecting peer, check for stray quotes/whitespace in your environment configuration.`);
  }
}
const connectionGate = (maxConnectionsEnv != null || allowedFingerprintsEnv.length)
  ? createConnectionGate({ maxConnections: maxConnectionsEnv, allowedFingerprints: allowedFingerprintsEnv.length ? allowedFingerprintsEnv : null })
  : null;

// allowDynamicSubscribe: true — on top of the static 'qu-demo-room/' below
// (kept for docs/lab/'s Network section, which relies on a fixed room), any
// connected client may additionally register its own topic at runtime via
// qu.subscribe() (network/replication/default.js) — what the Playground's
// "Bob" step and examples/relay-space-demo-lib.mjs's runtime-created App-Spaces
// rely on. Still fully ACL-gated per push, never a wider grant than the
// static case (README "Sync, Mirror, Relay").
//
// Which apps' writes actually trigger a push is entirely THIS deployment's
// choice (relay.mjs's `pushRules` doc comment) — relay.mjs itself has no
// idea Chat/Calendar/item-invites exist. This bundled deployment happens to
// serve all three example apps, so it opts all three in; a deployment
// serving only one of them would list only that one's rule.
const pushRules = [createChatPushRule(), createCalendarPushRule(), createItemInvitePushRule()];
relayApi = await createRelay({ store, fileStorage, identity: relayIdentity, pushTopics: ['qu-demo-room/'], allowDynamicSubscribe: true, requireDirectWriter, rateLimiter, connectionGate, sendPush, pushSubscriptions, pushRules, relayAdmins, serviceRegistry: registry, platformRegistry });
await relayApi.relay.publishProfile(); // makes ~<fingerprint>/epub discoverable — the one thing anything encrypting TO this relay needs to look up (also directly served at /relay/info above, no sync required)
bridgeWebSocketServer(server, relayApi, { path: '/relay' });
console.log(`[Relay] Identity: ${relayIdentity.fingerprint}${persistent ? ' (stable across restarts)' : ' (ephemeral — QU_STORE=memory, a fresh fingerprint every restart)'}`);
// The FULL list, not just a count — a count ("2 admin fingerprint(s)
// configured") can never reveal a subtle mismatch (wrong case, a stray
// quote character from a docker-compose quoting mistake, an extra
// space) between what an operator THINKS is configured and what
// actually landed in process.env; printing the exact strings this relay
// will compare against is what makes that kind of bug visible at a
// glance instead of needing a second debugging round trip.
console.log(relayAdmins.length
  ? `[Relay] Admin fingerprints configured (${relayAdmins.length}): ${relayAdmins.join(', ')}`
  : '[Relay] No QU_RELAY_ADMINS configured — no admin write access to relay-services/ or admin/');
console.log(pushEnabled
  ? `[Relay] Web Push enabled (${pushSubscriptions.size} stored subscription(s))`
  : '[Relay] Web Push disabled (QU_PUSH=0)');
console.log(connectionGate
  ? `[Relay] Connection limit active: ${JSON.stringify(connectionGate.getConfig())}`
  : '[Relay] No connection limit configured (QU_MAX_CONNECTIONS/QU_ALLOWED_FINGERPRINTS unset) — connections are unbounded');
