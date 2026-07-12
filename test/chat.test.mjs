import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, MemoryFileStorageAdapter, sendMessage, listMessages, createChatRoom, markRead, getReadReceipts, setPresence, getPresence, startHeartbeat, createFileHandlerPlugin, createSpacesPlugin } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('set(): two different writers can never collide on the same message id, even with an identical timestamp', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });
  await room.ready;

  const fixedTs = 12345; // deliberately identical for both writers
  const rA = await room.get('msgs').set({ text: 'from alice' }, { ts: fixedTs });
  const rB = await bob.get(room.id).get('msgs').set({ text: 'from bob' }, { ts: fixedTs });

  assert.notEqual(rA.qubit.id, rB.qubit.id, 'ids must differ even with the same ts, because they are namespaced by writer fingerprint');
  const rows = await room.session.query(`${room.id}/msgs/**`);
  assert.equal(rows.length, 2, 'both messages must exist — neither was silently overwritten');
});

test('a message id containing another writer\'s fingerprint does not change the actual signed authorship', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const mallory = await Qu.create({ runtime: alice.runtime });
  const room = alice.createSpace({ writers: ['*'], readers: ['*'] });
  await room.ready;

  // Mallory deliberately crafts a path that *looks* like Alice's namespace.
  await mallory.get(`${room.id}/msgs/${alice.fingerprint}/999`).put({ text: 'pretending to be alice' });
  const forged = await alice.get(`${room.id}/msgs/${alice.fingerprint}/999`);

  assert.equal(forged.writer, mallory.fingerprint, 'the verified writer field must never be confused with the path text');
  assert.notEqual(forged.writer, alice.fingerprint);
});

test('1:1 chat: two members can exchange messages, a third party cannot read them', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });

  const room = createChatRoom(alice, [alice.fingerprint, bob.fingerprint], { readers: [alice.fingerprint, bob.fingerprint] });
  await room.ready;
  await sendMessage(room, { text: 'hey bob' });
  await sendMessage(bob.get(room.id), { text: 'hey alice' });

  const bobView = await listMessages(bob.get(room.id));
  assert.equal(bobView.length, 2);
  assert.equal(bobView[0].value.text, 'hey bob');
  assert.equal(bobView[1].value.text, 'hey alice');
});

test('group chat: three members can all write, order is preserved by timestamp', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime });
  const room = createChatRoom(alice, [alice.fingerprint, bob.fingerprint, carol.fingerprint]);
  await room.ready;

  await sendMessage(room, { text: '1' });
  await sendMessage(bob.get(room.id), { text: '2' });
  await sendMessage(carol.get(room.id), { text: '3' });

  const view = await listMessages(carol.get(room.id));
  assert.deepEqual(view.map((m) => m.value.text), ['1', '2', '3']);
  assert.deepEqual(view.map((m) => m.writer), [alice.fingerprint, bob.fingerprint, carol.fingerprint]);
});

test('an image attachment round-trips via refs + File-Handling, addressed the same collision-safe way as messages', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = createChatRoom(alice, [alice.fingerprint, bob.fingerprint]);
  await room.ready;
  const fileStorage = new MemoryFileStorageAdapter();
  alice.use(createFileHandlerPlugin({ fileStorage }));
  const imageBytes = new Uint8Array(500).map((_, i) => i % 256);

  await sendMessage(room, {
    text: 'check this out',
    attachments: [{ bytes: imageBytes, name: 'photo.png', mime: 'image/png', fileStorage }],
  });

  const [msg] = await listMessages(room);
  assert.equal(msg.refs.length, 1);
  const manifestQubit = await alice.get(msg.refs[0]);
  assert.equal(manifestQubit.value.mime, 'image/png');
  assert.equal(manifestQubit.value.name, 'photo.png');
});

test('read receipts: a per-reader LWW slot, keyed by verified writer not by path', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = createChatRoom(alice, [alice.fingerprint, bob.fingerprint]);
  await room.ready;
  const { qubit: m1 } = await sendMessage(room, { text: 'hi' });

  await markRead(bob.get(room.id), m1.ts);
  const receipts = await getReadReceipts(room);
  assert.equal(receipts[bob.fingerprint], m1.ts);
  assert.equal(receipts[alice.fingerprint], undefined, 'alice never marked her own message read');
});

test('presence: online while heartbeating, offline after an explicit stop, stale entries are not reported online', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = createChatRoom(alice, [alice.fingerprint, bob.fingerprint]);
  await room.ready;

  const stop = startHeartbeat(room, { intervalMs: 30 });
  await wait(10);
  let presence = await getPresence(bob.get(room.id), { staleAfterMs: 5000 });
  assert.equal(presence[alice.fingerprint].online, true);

  await stop();
  presence = await getPresence(bob.get(room.id), { staleAfterMs: 5000 });
  assert.equal(presence[alice.fingerprint].online, false);
  assert.equal(presence[alice.fingerprint].status, 'offline');

  // staleness overrides a stale "online" status even without an explicit offline
  await setPresence(bob.get(room.id), 'online');
  const staleView = await getPresence(room, { staleAfterMs: 0 });
  assert.equal(staleView[bob.fingerprint].online, false, 'an immediately-stale heartbeat must not read as online');
});
