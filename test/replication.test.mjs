import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuRuntime, QuStore, MemoryAdapter, QuIdentity, QuSession,
  createLoopbackChannelPair, authenticateChannel, createACLPlugin, DefaultReplication, Router,
} from '../src/index.js';
import { makeRuntime, withSilencedConsoleError } from './helpers.mjs';
import { canonical } from '../src/core/sign.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('sync() delivers only what a wide read-ACL allows, and repair() re-delivery is idempotent', async () => {
  const server = makeRuntime();
  server.use(createACLPlugin(async () => null));
  const alice = await QuIdentity.generate();
  const sessServer = new QuSession(server, { identity: alice });
  await sessServer.publish('chat/room1/a', 'A');
  await sessServer.publish('chat/room1/b', 'B');
  await sessServer.publish('secret/room9/x', 'classified');

  const readACL = {
    'chat/room1/a': { readers: ['*'] },
    'chat/room1/b': { readers: ['*'] },
    'secret/room9/x': { readers: ['someone-else-fp'] },
  };

  const client = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, {
    getACL: async (id) => readACL[id] ?? { readers: ['*'] },
    peerFingerprint: 'client-fp',
  });
  const clientRepl = new DefaultReplication(client, chB, {});

  await clientRepl.sync({ topic: 'chat/room1', since: 0 });
  assert.equal((await client.query('chat/room1/**')).length, 2);

  await clientRepl.sync({ topic: 'secret/room9', since: 0 });
  assert.equal((await client.query('secret/room9/**')).length, 0, 'read-restricted qubit must not arrive via replication');

  const before = await client.query('chat/room1/**');
  await clientRepl.repair({ topic: 'chat/room1', since: Date.now() });
  const after = await client.query('chat/room1/**');
  assert.equal(after.length, before.length, 'repair() re-delivery must not duplicate');

  serverRepl.close();
  clientRepl.close();
});

test('sync() includes the topic\'s own root document (e.g. a Space manifest), not just what\'s nested under it', async () => {
  // `${topic}/**` alone structurally excludes the bare topic id itself
  // (patternToRegExp requires a literal '/' after it) — a Space's manifest
  // lives exactly at that bare id. Without this, a late-joining client
  // could sync() a room's messages but never learn who's allowed to
  // read/write it unless it happened to be connected at the exact moment
  // the manifest was written.
  const server = makeRuntime();
  server.use(createACLPlugin(async () => ({ writers: ['*'], readers: ['*'] })));
  const alice = await QuIdentity.generate();
  const sessServer = new QuSession(server, { identity: alice });
  await sessServer.publish('room1', { writers: [alice.fingerprint], readers: ['*'] }); // the "manifest" itself, at the bare topic id
  await sessServer.publish('room1/msgs/a', 'hello');

  const client = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { getACL: async () => ({ writers: ['*'], readers: ['*'] }), peerFingerprint: 'client-fp' });
  const clientRepl = new DefaultReplication(client, chB, {});

  await clientRepl.sync({ topic: 'room1', since: 0 });

  const manifest = await client.get('room1');
  assert.ok(manifest, 'the topic\'s own root document must be included in a sync(), not just its children');
  assert.deepEqual(manifest.value.writers, [alice.fingerprint]);
  assert.equal((await client.query('room1/**')).length, 1, 'nested content must still sync exactly as before — this is additive, not a replacement');

  serverRepl.close();
  clientRepl.close();
});

test('reciprocal sync: a single client-initiated sync() also flushes the server\'s view of the client\'s offline writes', async () => {
  const rtServer = makeRuntime();
  const rtClient = makeRuntime();
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const sessServer = new QuSession(rtServer, { identity: alice });
  const sessClient = new QuSession(rtClient, { identity: bob });

  await sessServer.publish('room/x/serverMsg', 'from server, pre-existing');
  await sessClient.publish('room/x/clientMsg', 'written offline by client'); // no network call yet

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const replServer = new DefaultReplication(rtServer, chA, {});
  const replClient = new DefaultReplication(rtClient, chB, {});

  await replClient.sync({ topic: 'room/x', since: 0 }); // client only asks FOR data
  await wait(20); // let the auto-reciprocated request round-trip

  const serverHasClientMsg = (await rtServer.query('room/x/**')).some((q) => q.id === 'room/x/clientMsg');
  const clientHasServerMsg = (await rtClient.query('room/x/**')).some((q) => q.id === 'room/x/serverMsg');
  assert.ok(serverHasClientMsg, 'server should have received the client\'s offline write without asking for it explicitly');
  assert.ok(clientHasServerMsg);

  replServer.close();
  replClient.close();
});

test('live push: a newly ingested QuBit reaches a connected peer without an explicit sync() call', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const replA = new DefaultReplication(rtA, chA, { pushTopics: ['live/'] });
  const replB = new DefaultReplication(rtB, chB, { pushTopics: ['live/'] });

  await sessA.publish('live/ticker/1', 'tick');
  await wait(20);

  assert.equal((await rtB.get('live/ticker/1'))?.value, 'tick');
  replA.close();
  replB.close();
});

test('authenticateChannel(): mutual handshake yields each side\'s cryptographically proven fingerprint', async () => {
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const { a: chA, b: chB } = createLoopbackChannelPair();

  const [fpSeenByA, fpSeenByB] = await Promise.all([
    authenticateChannel(chA, alice),
    authenticateChannel(chB, bob),
  ]);

  assert.equal(fpSeenByA, bob.fingerprint);
  assert.equal(fpSeenByB, alice.fingerprint);
});

test('a Mount with replicate:false is withheld by Replication even under a wide-open read-ACL', async () => {
  const alice = await QuIdentity.generate();
  const server = new QuRuntime({
    store: new QuStore([
      { prefix: '', adapter: new MemoryAdapter() },
      { prefix: 'private/', adapter: new MemoryAdapter(), replicate: false },
    ]),
  });
  server.use((await import('../src/core/verify.js')).createVerifyPlugin());
  const sess = new QuSession(server, { identity: alice });
  await sess.publish('private/device-key', 'never-leave-this-device');

  const client = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const replServer = new DefaultReplication(server, chA, { getACL: async () => ({ readers: ['*'] }) });
  const replClient = new DefaultReplication(client, chB, {});

  await replClient.sync({ topic: 'private', since: 0 });
  assert.equal((await client.query('private/**')).length, 0);

  replServer.close();
  replClient.close();
});

// Note: this test deliberately triggers a "[Replication] rejected incoming
// push" console.error — that is the test PASSING (it proves the rejection
// is handled gracefully), not a failure. If you see this line while running
// the suite (CLI or browser), it's this test, not a real bug.
test('a rejected push (e.g. a forged qubit from a misbehaving peer) does not crash the connection — subsequent legitimate messages still arrive', async () => {
  const server = makeRuntime(); // makeRuntime() already wires createVerifyPlugin()
  const client = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const replServer = new DefaultReplication(server, chA, {});
  const replClient = new DefaultReplication(client, chB, { pushTopics: ['room/'] });

  // Simulate a misbehaving peer pushing a qubit with a bogus signature.
  // Before the fix, DefaultReplication#handleMessage awaited runtime.ingest()
  // for an incoming push with no try/catch — a rejection here became an
  // unhandled promise rejection (process-crashing in Node by default).
  // A real, well-formed key (so the rejection is our own, meaningful
  // "[Verify] Fingerprint mismatch" check — not a confusing low-level
  // WebCrypto "malformed JWK" error from an intentionally-garbage key).
  const impostor = await QuIdentity.generate();
  const forged = { id: 'room/x', value: 'forged', ts: Date.now() };
  forged.sig = await impostor.sign(canonical(forged));
  forged.writer = 'not-the-impostors-real-fingerprint';
  forged.pubKey = await impostor.exportPublicSigningKey();

  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(client, { identity: alice });

  const errorCalls = await withSilencedConsoleError(async () => {
    await chB.send({ type: 'qu.push', qubit: forged });
    await wait(50);
    // The connection must still be fully usable afterwards.
    await sessAlice.publish('room/legit', 'still works');
    await wait(50);
  });
  assert.equal(errorCalls.length, 1, 'the rejection should have been logged (captured here, not printed)');
  await wait(50);

  const serverView = await server.query('room/legit');
  assert.equal(serverView.length, 1, 'a legitimate message after a rejected push must still arrive');
  const rejectedView = await server.query('room/x');
  assert.equal(rejectedView.length, 0, 'the rejected push must not have been silently accepted either');

  replServer.close();
  replClient.close();
});

test('Router-aware push: a mirror route always receives, a losing grouped sync route does not — no real WebRTC needed to prove this, loopback channels stand in for "some other transport"', async () => {
  const author = makeRuntime();

  const { a: chMirror, b: chMirrorPeer } = createLoopbackChannelPair('author-mirror', 'mirror-peer');
  const { a: chDirect, b: chDirectPeer } = createLoopbackChannelPair('author-direct', 'direct-peer');
  const { a: chRelay, b: chRelayPeer } = createLoopbackChannelPair('author-relay', 'relay-peer');

  const router = new Router();

  // The author has three outgoing channels: an always-on mirror, and two
  // competing ways to reach the same logical peer (a "direct" stand-in and
  // a "relay" stand-in) — grouped so they compete.
  const replMirror = new DefaultReplication(author, chMirror, { pushTopics: ['room/'], router });
  router.addRoute({ channelId: replMirror.channelId, channel: chMirror, pushTopics: ['room/'], role: 'mirror' });

  const replDirect = new DefaultReplication(author, chDirect, { pushTopics: ['room/'], router });
  router.addRoute({ channelId: replDirect.channelId, channel: chDirect, pushTopics: ['room/'], role: 'sync', group: 'peer:x', metric: 5, transport: 'direct-stand-in' });

  const replRelay = new DefaultReplication(author, chRelay, { pushTopics: ['room/'], router });
  router.addRoute({ channelId: replRelay.channelId, channel: chRelay, pushTopics: ['room/'], role: 'sync', group: 'peer:x', metric: 50, transport: 'relay-stand-in' });

  // Receiving ends just listen for the raw push message.
  const seenBy = { mirror: false, direct: false, relay: false };
  chMirrorPeer.onMessage((msg) => { if (msg.type === 'qu.push') seenBy.mirror = true; });
  chDirectPeer.onMessage((msg) => { if (msg.type === 'qu.push') seenBy.direct = true; });
  chRelayPeer.onMessage((msg) => { if (msg.type === 'qu.push') seenBy.relay = true; });

  const alice = await QuIdentity.generate();
  const session = new QuSession(author, { identity: alice });
  await session.publish('room/msg1', 'hello');
  await wait(50);

  assert.equal(seenBy.mirror, true, 'the mirror route must always receive the push');
  assert.equal(seenBy.direct, true, 'the lower-metric grouped route must win');
  assert.equal(seenBy.relay, false, 'the higher-metric grouped route must be skipped — this is the traffic reduction the Router exists for');

  replMirror.close();
  replDirect.close();
  replRelay.close();
});

test('without a router, DefaultReplication behaves exactly as before (backward compatible default)', async () => {
  const author = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const repl = new DefaultReplication(author, chA, { pushTopics: ['room/'] }); // no router at all

  let seen = false;
  chB.onMessage((msg) => { if (msg.type === 'qu.push') seen = true; });

  const alice = await QuIdentity.generate();
  const session = new QuSession(author, { identity: alice });
  await session.publish('room/msg1', 'hello');
  await wait(50);

  assert.equal(seen, true);
  repl.close();
});
