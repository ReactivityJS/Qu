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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/static-server.mjs';
import { createTestRoutes } from './server/test-runner.mjs';
import { createRelay } from './relay/relay.mjs';
import { bridgeWebSocketServer } from './relay/node-ws-bridge.mjs';
import { QuStore, MemoryAdapter, MemoryFileStorageAdapter, NullAdapter, enableConsoleDebug } from './src/index.js';
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

// /test/manifest.json is always on (read-only, no code runs); the
// server-side test-EXECUTION endpoint (/test/run-node-tests) is opt-in via
// QU_ENABLE_TEST_ENDPOINT=1 — see server/test-runner.mjs for why.
const server = startServer({ root, port, routes: createTestRoutes({ root }) });

// Two supported startup modes, chosen once at process start — flüchtig
// (in-memory, gone on restart, no disk I/O at all: quick local testing,
// ephemeral relay instances) or persistent (the default: a durable,
// file-backed mirror that survives a restart). `QU_STORE=memory` to opt
// into the former; anything else (including unset) keeps the previous,
// always-persistent default so existing deployments see no behavior change.
const persistent = process.env.QU_STORE !== 'memory';
const store = new QuStore([
  { prefix: '', adapter: persistent ? new FileSystemStorageAdapter(path.join(dataDir, 'qubits.ndjson')) : new MemoryAdapter() },
  { prefix: 'signal/', adapter: new NullAdapter() },
]);
const fileStorage = persistent ? new FileSystemFileStorageAdapter(path.join(dataDir, 'files')) : new MemoryFileStorageAdapter();
const relayApi = await createRelay({ store, fileStorage, pushTopics: ['qu-demo-room/'] });
bridgeWebSocketServer(server, relayApi, { path: '/relay' });

