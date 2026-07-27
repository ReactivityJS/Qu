import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createNetworkPlugin, createWebSocketChannel, createConnectionGate, createRateLimiter, QuIdentity, QuSession, QuStore, MemoryAdapter, NullAdapter } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { startTestRelayServer, stopTestRelayServer, withSilencedConsoleError } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeStoreWithAdminPrefix() {
  return new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'admin/', adapter: new NullAdapter(), replicate: false },
  ]);
}

/**
 * Registers cleanup on `t`: every channel passed must be closed BEFORE the
 * server itself, or `server.close()` hangs forever waiting for a still-open
 * WebSocket-upgraded socket it can't otherwise reach (see
 * stopTestRelayServer's own doc comment) — this bit CI hard the first time
 * this file was written (an assertion failure skipped the test body's own
 * channel-close lines, and t.after() only closed the server, not the still-
 * open channels, hanging the whole run with no further test output at all).
 */
function registerCleanup(t, server, channels) {
  t.after(async () => {
    for (const ch of channels) await ch?.close().catch(() => {});
    await stopTestRelayServer(server).catch(() => {});
  });
}

test('connectionGate: maxConnections rejects (and closes) a connection once the ceiling is already reached', async (t) => {
  const relayInfo = await startTestRelayServer({ connectionGate: createConnectionGate({ maxConnections: 1 }) });
  const { server, port } = relayInfo;
  const url = `ws://127.0.0.1:${port}/relay`;
  const channels = [];
  registerCleanup(t, server, channels);

  const alice = (await Qu.create()).use(createNetworkPlugin());
  const chA = createWebSocketChannel(url);
  channels.push(chA);
  await chA.connect();
  await alice.connect(chA, { pushTopics: [''] });
  await wait(50);
  assert.equal(relayInfo.connectedCount, 1, 'the first connection is accepted normally');

  const bob = (await Qu.create()).use(createNetworkPlugin());
  const chB = createWebSocketChannel(url);
  channels.push(chB);
  let bobClosed = false;
  chB.onClose(() => { bobClosed = true; });
  await chB.connect();
  await bob.connect(chB, { pushTopics: [''] }); // client-side handshake still succeeds — the relay rejects it server-side, after
  await wait(100);

  assert.equal(bobClosed, true, 'the relay must close a connection rejected by the connection gate, not leave it half-open');
  assert.equal(relayInfo.connectedCount, 1, 'the rejected connection must never be counted as connected');
});

test('connectionGate: allowedFingerprints rejects a fingerprint not on the list', async (t) => {
  const relayInfo = await startTestRelayServer({ connectionGate: createConnectionGate({ allowedFingerprints: ['0'.repeat(24)] }) });
  const { server, port } = relayInfo;
  const url = `ws://127.0.0.1:${port}/relay`;
  const channels = [];
  registerCleanup(t, server, channels);

  const outsider = (await Qu.create()).use(createNetworkPlugin());
  const ch = createWebSocketChannel(url);
  channels.push(ch);
  let closed = false;
  ch.onClose(() => { closed = true; });
  await ch.connect();
  await outsider.connect(ch, { pushTopics: [''] });
  await wait(100);

  assert.equal(closed, true, 'a fingerprint absent from the allowlist must be rejected/closed');
  assert.equal(relayInfo.connectedCount, 0);
});

test('admin/config/rate-limit: a signed+encrypted command from an admin fingerprint reconfigures the live rate limiter', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 100, windowMs: 1000 });
  const admin = await QuIdentity.generate();
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix(), relayAdmins: [admin.fingerprint], rateLimiter: limiter });

  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  await adminSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  assert.deepEqual(relayApi.getAdminConfig().rateLimit, { maxPerWindow: 100, windowMs: 1000 });
  await adminSession.publish('admin/config/rate-limit', { maxPerWindow: 5, windowMs: 2000 }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(20);
  assert.deepEqual(relayApi.getAdminConfig().rateLimit, { maxPerWindow: 5, windowMs: 2000 }, 'the command must live-reconfigure the installed rate limiter');
});

test('admin/config/connection-limit: an admin command reconfigures the live connection gate', async () => {
  const admin = await QuIdentity.generate();
  const gate = createConnectionGate();
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix(), relayAdmins: [admin.fingerprint], connectionGate: gate });

  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  await adminSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  await adminSession.publish('admin/config/connection-limit', { maxConnections: 3, allowedFingerprints: ['a'.repeat(24)] }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(20);
  assert.deepEqual(relayApi.getAdminConfig().connectionLimit, { maxConnections: 3, allowedFingerprints: ['a'.repeat(24)] });
});

test('admin/config/connection-limit: a non-admin fingerprint is rejected at the ACL layer, never reaches dispatch', async () => {
  const admin = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const gate = createConnectionGate();
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix(), relayAdmins: [admin.fingerprint], connectionGate: gate });
  const outsiderSession = new QuSession(relayApi.relay.runtime, { identity: outsider });
  await outsiderSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  await withSilencedConsoleError(async () => {
    await assert.rejects(
      outsiderSession.publish('admin/config/connection-limit', { maxConnections: 0 }, { encryptFor: [relayApi.relay.fingerprint] }),
      /ACL/,
    );
  });
  await wait(10);
  assert.deepEqual(gate.getConfig(), { maxConnections: null, allowedFingerprints: null }, 'a rejected write must never reach connectionGate.configure()');
});
