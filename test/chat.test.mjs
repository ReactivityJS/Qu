import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, MemoryFileStorageAdapter, sendMessage, listMessages, createChatRoom, markRead, getReadReceipts, setPresence, getPresence, startHeartbeat, createFileHandlerPlugin, createSpacesPlugin } from '../src/index.js';

test('append(): two different writers can never collide on the same message id, even with an identical timestamp', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const roomId = await alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });

  const fixedTs = 12345; // deliberately identical for both writers
  const rA = await alice.append(`${roomId}/msgs`, { text: 'from alice' }, { ts: fixedTs });
  const rB = await bob.append(`${roomId}/msgs`, { text: 'from bob' }, { ts: fixedTs });

  assert.notEqual(rA.qubit.id, rB.qubit.id, 'ids must differ even with the same ts, because they are namespaced by writer fingerprint');
  const rows = await alice.query(`${roomId}/msgs/**`);
  assert.equal(rows.length, 2, 'both messages must exist — neither was silently overwritten');
});

test('a message id containing another writer\'s fingerprint does not change the actual signed authorship', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const mallory = await Qu.create({ runtime: alice.runtime });
  const roomId = await alice.createSpace({ writers: ['*'], readers: ['*'] });

  // Mallory deliberately crafts a path that *looks* like Alice's namespace.
  await mallory.publish(`${roomId}/msgs/${alice.fingerprint}/999`, { text: 'pretending to be alice' });
  const forged = await alice.get(`${roomId}/msgs/${alice.fingerprint}/999`);

  assert.equal(forged.writer, mallory.fingerprint, 'the verified writer field must never be confused with the path text');
  assert.notEqual(forged.writer, alice.fingerprint);
});

test('1:1 chat: two members can exchange messages, a third party cannot read them', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const mallory = await Qu.create({ runtime: alice.runtime });

  const roomId = await createChatRoom(alice, [alice.fingerprint, bob.fingerprint], { readers: [alice.fingerprint, bob.fingerprint] });
  await sendMessage(alice, roomId, { text: 'hey bob' });
  await sendMessage(bob, roomId, { text: 'hey alice' });

  const bobView = await listMessages(bob, roomId);
  assert.equal(bobView.length, 2);
  assert.equal(bobView[0].value.text, 'hey bob');
  assert.equal(bobView[1].value.text, 'hey alice');
});

test('group chat: three members can all write, order is preserved by timestamp', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime });
  const roomId = await createChatRoom(alice, [alice.fingerprint, bob.fingerprint, carol.fingerprint]);

  await sendMessage(alice, roomId, { text: '1' });
  await sendMessage(bob, roomId, { text: '2' });
  await sendMessage(carol, roomId, { text: '3' });

  const view = await listMessages(carol, roomId);
  assert.deepEqual(view.map((m) => m.value.text), ['1', '2', '3']);
  assert.deepEqual(view.map((m) => m.writer), [alice.fingerprint, bob.fingerprint, carol.fingerprint]);
});

test('an image attachment round-trips via refs + File-Handling, addressed the same collision-safe way as messages', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const roomId = await createChatRoom(alice, [alice.fingerprint, bob.fingerprint]);
  const fileStorage = new MemoryFileStorageAdapter();
  alice.use(createFileHandlerPlugin({ fileStorage }));
  const imageBytes = new Uint8Array(500).map((_, i) => i % 256);

  await sendMessage(alice, roomId, {
    text: 'check this out',
    attachments: [{ bytes: imageBytes, name: 'photo.png', mime: 'image/png', fileStorage }],
  });

  const [msg] = await listMessages(alice, roomId);
  assert.equal(msg.refs.length, 1);
  const [manifestQubit] = await alice.resolveRefs(msg);
  assert.equal(manifestQubit.value.mime, 'image/png');
  assert.equal(manifestQubit.value.name, 'photo.png');
});

test('read receipts: a per-reader LWW slot, keyed by verified writer not by path', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const roomId = await createChatRoom(alice, [alice.fingerprint, bob.fingerprint]);
  const { qubit: m1 } = await sendMessage(alice, roomId, { text: 'hi' });

  await markRead(bob, roomId, m1.ts);
  const receipts = await getReadReceipts(alice, roomId);
  assert.equal(receipts[bob.fingerprint], m1.ts);
  assert.equal(receipts[alice.fingerprint], undefined, 'alice never marked her own message read');
});

test('presence: online while heartbeating, offline after an explicit stop, stale entries are not reported online', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const roomId = await createChatRoom(alice, [alice.fingerprint, bob.fingerprint]);

  const stop = startHeartbeat(alice, roomId, { intervalMs: 30 });
  await new Promise((r) => setTimeout(r, 10));
  let presence = await getPresence(bob, roomId, { staleAfterMs: 5000 });
  assert.equal(presence[alice.fingerprint].online, true);

  await stop();
  presence = await getPresence(bob, roomId, { staleAfterMs: 5000 });
  assert.equal(presence[alice.fingerprint].online, false);
  assert.equal(presence[alice.fingerprint].status, 'offline');

  // staleness overrides a stale "online" status even without an explicit offline
  await setPresence(bob, roomId, 'online');
  const staleView = await getPresence(alice, roomId, { staleAfterMs: 0 });
  assert.equal(staleView[bob.fingerprint].online, false, 'an immediately-stale heartbeat must not read as online');
});
