import assert from 'node:assert/strict';
import http from 'node:http';
import { QuRuntime, QuStore, MemoryAdapter, createVerifyPlugin } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { bridgeWebSocketServer } from '../relay/node-ws-bridge.mjs';

export function makeRuntime() {
  const rt = new QuRuntime({ store: new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]) });
  rt.use(createVerifyPlugin());
  return rt;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(o + 65536, n)));
  return out;
}

/**
 * A handful of tests deliberately trigger an error path (a forged qubit, a
 * throwing subscriber) specifically to prove it's handled gracefully — the
 * resulting console.error is the test passing, not failing. Without this,
 * that expected noise is indistinguishable from a real problem when
 * watching the console (CLI or browser) during a normal run. Captures the
 * calls (so the test can still assert on them) without ever printing them.
 */
/**
 * The shared assertions every StorageAdapter (`core/storage.js`) must
 * satisfy, run once per concrete adapter instead of duplicated per test
 * file — used by both test/storage-adapters.test.mjs (Memory/Null, work
 * identically in Node and the browser) and
 * test/storage-adapters-browser.test.mjs (LocalStorage/SessionStorage/
 * IndexedDB, real-browser-only). Deliberately covers only the four methods
 * `assertStorageAdapter()` actually requires (get/put/delete/getAll) — not
 * `clear()` (present on most adapters as a convenience, not part of the
 * Core contract) and not FileSystemStorageAdapter's own extra
 * out-of-order-log-reconciliation guarantee (test/adapters-filesystem.test.mjs),
 * which is specific to its append-only-log format, not something every
 * adapter needs to promise.
 */
export async function assertStorageAdapterContract(adapter) {
  const a = { id: 'contract/a', value: 'first', ts: 1 };
  const b = { id: 'contract/b', value: 'second', ts: 2 };
  const other = { id: 'elsewhere/c', value: 'third', ts: 3 };

  assert.equal(await adapter.get('contract/never-written'), null, 'get() on an unknown id must return null, not throw or return undefined');

  await adapter.put(a.id, a);
  await adapter.put(b.id, b);
  await adapter.put(other.id, other);

  assert.deepEqual(await adapter.get(a.id), a, 'get() must return exactly what was put()');

  const prefixed = await adapter.getAll('contract/');
  assert.equal(prefixed.length, 2, 'getAll(prefix) must return every entry under that prefix...');
  assert.ok(prefixed.every((q) => q.id.startsWith('contract/')), '...and nothing outside it');

  await adapter.delete(a.id);
  assert.equal(await adapter.get(a.id), null, 'delete() must make a subsequent get() return null');
  assert.equal((await adapter.getAll('contract/')).length, 1, 'delete() must also remove the entry from getAll()');
}

/**
 * A real relay over a real WebSocket server on an ephemeral port — the
 * exact same handful of lines (http.createServer + listen(0) +
 * createRelay() + bridgeWebSocketServer()) was independently duplicated
 * across test/relay.test.mjs, test/relay-mirror.test.mjs,
 * test/relay-push.test.mjs, and examples/relay-space-demo-lib.test.mjs, each with
 * its own slightly-differently-named local `startTestServer()`. `relayOpts`
 * is passed straight through to createRelay() — the STORE/fileStorage/
 * pushTopics/sendPush shape a specific test needs stays entirely with that
 * test, only the server bootstrapping itself is shared here.
 */
export async function startTestRelayServer(relayOpts = {}) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const relayApi = await createRelay(relayOpts);
  bridgeWebSocketServer(server, relayApi, { path: '/relay' });
  // NOT a plain `{ ...relayApi }` spread: relayApi.connectedCount (relay.mjs)
  // is a live getter, and a spread evaluates every getter ONCE, baking in
  // whatever it returned at spread time (here: always 0, read before any
  // connection exists) as a frozen plain value forever after — a caller
  // checking `result.connectedCount` later would silently get a stale
  // snapshot instead of the actual current count. Copying the property
  // DESCRIPTORS instead (not the values) re-installs the same getter
  // function on the merged object, which still closes over relay.mjs's own
  // `connected` Map, so it stays genuinely live.
  return Object.defineProperties(
    { server, port, url: `ws://127.0.0.1:${port}/relay` },
    Object.getOwnPropertyDescriptors(relayApi),
  );
}

/**
 * Counterpart to startTestRelayServer(). `closeAllConnections()` does NOT
 * reach a WebSocket-upgraded socket — the upgrade hijacks it out of
 * http.Server's normal connection tracking — so this only reliably
 * resolves if every CLIENT channel talking to this server was already
 * closed beforehand; otherwise the awaited `server.close()` callback can
 * hang forever waiting for a connection it doesn't know is still open
 * (confirmed the hard way — see examples/relay-space-demo-lib.test.mjs's git
 * history for the CI hang this caused when a cleanup hook closed the
 * server before its channels).
 */
export async function stopTestRelayServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

export async function withSilencedConsoleError(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => { calls.push(args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}
