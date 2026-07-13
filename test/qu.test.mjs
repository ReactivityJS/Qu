import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, QuIdentity, userSpaceId, createLoopbackChannelPair, MemoryFileStorageAdapter, reassembleFile, createNetworkPlugin, createWebRTCPlugin, createFileHandlerPlugin, createSpacesPlugin } from '../src/index.js';

test('Qu.create() generates an identity and can put/read — under its own User-Space, with zero plugins installed', async () => {
  const alice = await Qu.create();
  assert.ok(alice.fingerprint);
  await alice.get(`${alice.userSpaceId}/chat/room1/msg1`).put({ text: 'hi' });
  const rows = await alice.session.query(`${alice.userSpaceId}/chat/room1/**`);
  assert.equal(rows[0].value.text, 'hi');
});

test('without the Spaces plugin, a generic (non-User) path is unwritable — the Core default only ever grants your own User-Space', async () => {
  const alice = await Qu.create();
  assert.equal(typeof alice.createSpace, 'undefined', 'createSpace() must not exist before qu.use(createSpacesPlugin())');
  await assert.rejects(() => alice.get('chat/room1/msg1').put('nope'), /\[ACL\] Write denied/);
});

test('a guest instance has an identity but cannot write — even to its own User-Space, even with createSpace() available', async () => {
  const guest = (await Qu.create({ guest: true })).use(createSpacesPlugin());
  assert.ok(guest.fingerprint, 'guests still get a real, ephemeral identity');
  assert.equal(guest.isGuest, true);
  await assert.rejects(() => guest.own.get('msg1').put('nope'));
  assert.throws(() => guest.createSpace()); // synchronous — see modules/spaces.js
});

test('a User-Space profile is just individual leaf QuBits under its root, not one combined object', async () => {
  const alice = await Qu.create();
  await alice.own.get('pub').put(alice.fingerprint);
  await alice.own.get('alias').put('alice');
  await alice.own.get('epub').put({ kty: 'EC', x: 'stub' });

  const aliasQubit = await alice.own.get('alias');
  const pubQubit = await alice.own.get('pub');
  assert.equal(aliasQubit.value, 'alice');
  assert.equal(pubQubit.value, alice.fingerprint);

  const bob = await Qu.create({ runtime: alice.runtime });
  const aliceProfile = bob.get(userSpaceId(alice.fingerprint));
  assert.equal((await aliceProfile.get('alias')).value, 'alice');
  assert.equal((await aliceProfile.get('pub')).value, alice.fingerprint);
});

test('two Qu instances can share one Runtime without double-registering middleware', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });

  const rA = await alice.get('shared/note1').put('from alice');
  const rB = await bob.get('shared/note2').put('from bob');
  assert.equal(rA.qubit.writer, alice.fingerprint);
  assert.equal(rB.qubit.writer, bob.fingerprint);
});

test('createSpace() via the facade produces a working, ACL-enforced Space', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] }); // synchronous — see modules/spaces.js
  await room.ready; // wait for the manifest write to land — "await room" alone is a read and can race ahead of it

  await assert.rejects(() => bob.get(room.id).get('msg1').put('bob tries to post'));
  await room.get('msg1').put('alice posts');
  assert.equal((await bob.session.query(`${room.id}/**`))[0].value, 'alice posts');
});

test('connect() authenticates the channel and returns a working DefaultReplication', async () => {
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { a, b } = createLoopbackChannelPair();

  const [replAlice, replBob] = await Promise.all([alice.connect(a), bob.connect(b)]);
  await alice.get('chat/room1/msg1').put('hello from alice');
  await replBob.sync({ topic: 'chat/room1', since: 0 });

  assert.equal((await bob.session.query('chat/room1/**'))[0].value, 'hello from alice');
  replAlice.close();
  replBob.close();
});

test('shareFile()/fileTransfer() work through the facade', async () => {
  const aliceFiles = new MemoryFileStorageAdapter();
  const bobFiles = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createFileHandlerPlugin({ fileStorage: aliceFiles }));
  const bob = (await Qu.create()).use(createFileHandlerPlugin({ fileStorage: bobFiles }));
  const bytes = new TextEncoder().encode('hello file');

  const { manifestId } = await alice.shareFile(`${alice.userSpaceId}/files/f1`, bytes, { name: 'f.txt', fileStorage: aliceFiles }); // under alice's own User-Space — no Spaces plugin needed; bob's runtime accepts it on ingest because the ACL check is id-owner-based, not "who's asking locally"

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferAlice = alice.fileTransfer(chA, aliceFiles);
  const xferBob = bob.fileTransfer(chB, bobFiles);
  await xferBob.requestFile(manifestId);
  const manifest = (await bob.get(manifestId)).value;
  const received = await reassembleFile(bobFiles, manifest);

  assert.deepEqual(received, bytes);
  xferAlice.close();
  xferBob.close();
});

test('Qu.create({ identity }) reuses an existing QuIdentity or re-imported keys', async () => {
  const original = await QuIdentity.generate();
  const alice1 = await Qu.create({ identity: original });
  assert.equal(alice1.fingerprint, original.fingerprint);

  const keys = await original.exportKeys();
  const alice2 = await Qu.create({ identity: keys });
  assert.equal(alice2.fingerprint, original.fingerprint);
});

test('qu.connect() with role/group/metric registers a route; without them, behaves exactly as before (no router involvement)', async () => {
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const bob = (await Qu.create({ runtime: alice.runtime })).use(createNetworkPlugin());

  const { a: chMirror, b: chMirrorPeer } = createLoopbackChannelPair('a-mirror', 'b-mirror');
  const { a: chPlain, b: chPlainPeer } = createLoopbackChannelPair('a-plain', 'b-plain');

  // Opt-in: registers a mirror route.
  const [replMirror] = await Promise.all([
    alice.connect(chMirror, { pushTopics: ['room/'], role: 'mirror' }),
    bob.connect(chMirrorPeer, { pushTopics: [] }),
  ]);
  assert.equal(alice.router.getRoute(replMirror.channelId).role, 'mirror');

  // No role/group/metric passed at all: no router involvement, exactly the pre-Router behavior.
  const [replPlain] = await Promise.all([
    alice.connect(chPlain, { pushTopics: ['room/'] }),
    bob.connect(chPlainPeer, { pushTopics: [] }),
  ]);
  assert.equal(alice.router.getRoute(replPlain.channelId), null, 'a connect() call with no routing metadata must not register anything with the router');

  let seenByMirror = false;
  let seenByPlain = false;
  chMirrorPeer.onMessage((msg) => { if (msg.type === 'qu.push') seenByMirror = true; });
  chPlainPeer.onMessage((msg) => { if (msg.type === 'qu.push') seenByPlain = true; });

  await alice.get('room/msg1').put('hi');
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(seenByMirror, true, 'the mirror-registered channel must still push normally');
  assert.equal(seenByPlain, true, 'a channel with no router registration must push unconditionally, as before');

  replMirror.close();
  replPlain.close();
});

test('qu.webrtc() creates a PeerConnectionManager wired to this Qu instance\'s router', async () => {
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createWebRTCPlugin());
  const { a: signalA } = createLoopbackChannelPair();
  const pm = alice.webrtc(signalA);
  assert.ok(pm);
  assert.deepEqual(pm.connectedFingerprints, []);
  pm.close();
});

test('createWebRTCPlugin() requires createNetworkPlugin() to already be installed (shares its Router)', async () => {
  const alice = await Qu.create();
  assert.throws(() => alice.use(createWebRTCPlugin()), /createNetworkPlugin\(\)/);
});
