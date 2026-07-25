import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuIdentity, QuSession, createLoopbackChannelPair, DefaultReplication,
  Qu, createNetworkPlugin, createSpacesPlugin, createACLPlugin, createSpaceACLResolver,
} from '../src/index.js';
import { makeRuntime } from './helpers.mjs';

function wait(ms = 30) { return new Promise((r) => setTimeout(r, ms)); }

test('allowDynamicSubscribe: false (default) — a qu.subscribe request is silently ignored, byte-identical to before this feature existed', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(server, { identity: alice }); // writes land on the SERVER — must arrive at client only via push

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA); // pushTopics/allowDynamicSubscribe both default — nothing pushed, ever
  const clientRepl = new DefaultReplication(client, chB, { pushTopics: [''] });

  await clientRepl.subscribe('room/');
  await wait();
  await sessAlice.publish('room/msg1', { text: 'hi' });
  await wait();

  assert.equal(await client.get('room/msg1'), null, 'the SERVER never pushes back — no pushTopics, allowDynamicSubscribe off — subscribe() request was ignored');
  serverRepl.close();
  clientRepl.close();
});

test('allowDynamicSubscribe: true — a runtime qu.subscribe request is honored; the server starts pushing matching writes it did not know about in advance', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(server, { identity: alice });

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { allowDynamicSubscribe: true }); // NO pushTopics configured up front — "unbound"
  const clientRepl = new DefaultReplication(client, chB);

  await clientRepl.subscribe('freshly-created-space/');
  await wait();
  await sessAlice.publish('freshly-created-space/msg1', { text: 'hallo' });
  await wait();

  const stored = await client.get('freshly-created-space/msg1');
  assert.equal(stored?.value.text, 'hallo', 'a topic the relay was never configured with in advance is pushed once a client asks for it at runtime');
  serverRepl.close();
  clientRepl.close();
});

test('allowDynamicSubscribe as a ceiling (string[]): a request within an allowed prefix is honored, one outside is silently ignored', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(server, { identity: alice });

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { allowDynamicSubscribe: ['allowed-app/'] });
  const clientRepl = new DefaultReplication(client, chB);

  await clientRepl.subscribe('allowed-app/');
  await clientRepl.subscribe('other-app/');
  await wait();

  await sessAlice.publish('allowed-app/x', 'in ceiling');
  await sessAlice.publish('other-app/x', 'outside ceiling');
  await wait();

  assert.equal((await client.get('allowed-app/x'))?.value, 'in ceiling');
  assert.equal(await client.get('other-app/x'), null, 'a topic outside the ceiling is never pushed, even though the client asked for it');
  serverRepl.close();
  clientRepl.close();
});

test('a topic within the ceiling is honored even if it is a longer/more specific prefix than the ceiling entry', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(server, { identity: alice });

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { allowDynamicSubscribe: ['app1/'] });
  const clientRepl = new DefaultReplication(client, chB);

  await clientRepl.subscribe('app1/sub-space-42/'); // more specific than the ceiling, still covered by it
  await wait();
  await sessAlice.publish('app1/sub-space-42/x', 'ok');
  await wait();

  assert.equal((await client.get('app1/sub-space-42/x'))?.value, 'ok');
  serverRepl.close();
  clientRepl.close();
});

test('ACL still gates delivery regardless of dynamic subscribe — a subscribed topic the peer is not allowed to read is never pushed', async () => {
  const runtime = makeRuntime();
  const acl = createSpaceACLResolver(runtime);
  runtime.use(createACLPlugin(acl));
  const owner = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const sessOwner = new QuSession(runtime, { identity: owner, getACL: acl });

  // A restricted Space — outsider is not a reader.
  await sessOwner.publish('restricted-space', { admins: [owner.fingerprint], writers: [owner.fingerprint], readers: [owner.fingerprint] });

  const client = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(runtime, chA, { getACL: acl, peerFingerprint: outsider.fingerprint, allowDynamicSubscribe: true });
  const clientRepl = new DefaultReplication(client, chB);

  await clientRepl.subscribe('restricted-space/'); // outsider CAN ask — the request itself is not gated by ACL
  await wait();
  await sessOwner.publish('restricted-space/secret', 'shh');
  await wait();

  assert.equal(await client.get('restricted-space/secret'), null, 'subscribing does not bypass the per-QuBit read ACL — nothing is delivered to a non-reader');
  serverRepl.close();
  clientRepl.close();
});

test('maxDynamicTopics caps how many NEW topics one connection may register — already-active topics don\'t count against it', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { pushTopics: ['already-active/'], allowDynamicSubscribe: true, maxDynamicTopics: 2 });
  const clientRepl = new DefaultReplication(client, chB);

  await clientRepl.subscribe('already-active/'); // no-op, already in pushTopics — must not count against the cap
  await clientRepl.subscribe('new-1/');
  await clientRepl.subscribe('new-2/');
  await clientRepl.subscribe('new-3/'); // exceeds the cap of 2 new topics
  await wait();

  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(server, { identity: alice });
  await sessAlice.publish('new-1/x', 'a');
  await sessAlice.publish('new-2/x', 'b');
  await sessAlice.publish('new-3/x', 'c');
  await wait();

  assert.equal((await client.get('new-1/x'))?.value, 'a');
  assert.equal((await client.get('new-2/x'))?.value, 'b');
  assert.equal(await client.get('new-3/x'), null, 'the 3rd NEW dynamic topic exceeds maxDynamicTopics and is rejected');
  serverRepl.close();
  clientRepl.close();
});

test('ensureSynced(topic): pulls existing data via sync() THEN subscribes for live delivery — one call covers both', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(server, { identity: alice });
  await sessAlice.publish('room', 'already here before client connects');

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { allowDynamicSubscribe: true });
  const clientRepl = new DefaultReplication(client, chB);

  await clientRepl.ensureSynced('room'); // bare id — sync()'s ${topic}/** convention, also correct as a pushTopics prefix
  assert.equal((await client.get('room'))?.value, 'already here before client connects', 'sync() half already pulled pre-existing data');

  await sessAlice.publish('room/later', 'written after ensureSynced() was called');
  await wait();
  assert.equal((await client.get('room/later'))?.value, 'written after ensureSynced() was called', 'subscribe() half now delivers live writes too');
  serverRepl.close();
  clientRepl.close();
});

test('QuSpace on()/map(): activating a listener asks every connected peer to push the resolved topic — real end-to-end via createNetworkPlugin()', async () => {
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { a: chA, b: chB } = createLoopbackChannelPair();
  // alice starts with NO pushTopics — she only ever pushes a topic once bob
  // (dynamically, at runtime) asks for it; allowDynamicSubscribe is what
  // lets her honor that request at all. bob pushes nothing of his own but
  // relies on his on()/map() calls to request what he needs, on demand.
  await Promise.all([
    alice.connect(chA, { pushTopics: [], subscribeOwnSpace: false, allowDynamicSubscribe: true }),
    bob.connect(chB, { pushTopics: [], subscribeOwnSpace: false }),
  ]);

  const space = alice.createSpace({ writers: ['*'], readers: ['*'] });
  await space.ready;

  const seen = [];
  bob.get(space.id).get('items').map((q) => seen.push(q.value.text));
  await wait(150); // on()/map()'s subscribeDispatch -> ensureSynced() round-trip

  await space.get('items').set({ text: 'live via auto-subscribe' });
  await wait(150);
  assert.deepEqual(seen, ['live via auto-subscribe'], 'bob never configured pushTopics for this Space — map() itself triggered the network subscribe');
});

test('QuSpace on()/map() { raw: true } skips the network subscribe entirely — no request is sent, matching pre-feature behavior', async () => {
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { a: chA, b: chB } = createLoopbackChannelPair();
  await Promise.all([
    alice.connect(chA, { pushTopics: [], subscribeOwnSpace: false, allowDynamicSubscribe: true }),
    bob.connect(chB, { pushTopics: [], subscribeOwnSpace: false }),
  ]);

  const space = alice.createSpace({ writers: ['*'], readers: ['*'] });
  await space.ready;

  const seen = [];
  bob.get(space.id).get('items').map((q) => seen.push(q.value.text), { raw: true });
  await wait(150);

  await space.get('items').set({ text: 'should never arrive' });
  await wait(150);
  assert.deepEqual(seen, [], 'raw:true skips the auto-subscribe — bob never asked for this topic');
});

test('qu.connect()\'s default subscribeOwnSpace: true asks the peer to push the caller\'s own Space back — multi-device sync without extra configuration', async () => {
  const identity = await (await Qu.create()).exportKeys();
  const deviceA = (await Qu.create({ identity })).use(createNetworkPlugin());
  const deviceB = (await Qu.create({ identity })).use(createNetworkPlugin());
  const { a: chA, b: chB } = createLoopbackChannelPair();

  // Both sides' connect() must run CONCURRENTLY, not sequentially — each
  // side's handshake only resolves once the OTHER side has also called
  // connect() and responded; awaiting one fully before starting the other
  // deadlocks until the handshake timeout.
  //
  // deviceA starts with NO pushTopics of her own and only pushes once
  // asked (allowDynamicSubscribe) — isolates subscribeOwnSpace's effect
  // from deviceA independently already pushing her own Space regardless.
  await Promise.all([
    deviceA.connect(chA, { pushTopics: [], allowDynamicSubscribe: true }),
    deviceB.connect(chB), // subscribeOwnSpace defaults to true — no pushTopics needed to RECEIVE
  ]);

  await wait();
  await deviceA.own.get('setting').put('dark-mode');
  await wait(150);

  const seenOnB = await deviceB.session.get(`${deviceB.userSpaceId}/setting`);
  assert.equal(seenOnB?.value, 'dark-mode', 'deviceB received deviceA\'s write to their shared identity\'s own Space, purely from connecting');
});

test('qu.connect({ subscribeOwnSpace: false }) opts out — no automatic own-Space subscribe request is sent', async () => {
  const identity = await (await Qu.create()).exportKeys();
  const deviceA = (await Qu.create({ identity })).use(createNetworkPlugin());
  const deviceB = (await Qu.create({ identity })).use(createNetworkPlugin());
  const { a: chA, b: chB } = createLoopbackChannelPair();

  await Promise.all([
    deviceA.connect(chA, { pushTopics: [], allowDynamicSubscribe: true }), // same isolation as the previous test
    deviceB.connect(chB, { subscribeOwnSpace: false }),
  ]);

  await wait();
  await deviceA.own.get('setting').put('dark-mode');
  await wait(150);

  const seenOnB = await deviceB.session.get(`${deviceB.userSpaceId}/setting`);
  assert.equal(seenOnB, null, 'without subscribeOwnSpace, deviceB never asked to receive its own Space and does not see the write');
});
