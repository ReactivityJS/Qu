import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, QuSpace, QuStore, MemoryAdapter, NullAdapter, createSpacesPlugin } from '../src/index.js';

test('qu.own is a QuSpace bound to the User-Space, relative paths resolve under it', async () => {
  const alice = await Qu.create();
  assert.equal(alice.own.id, alice.userSpaceId);
  assert.equal(String(alice.own), alice.userSpaceId);

  await alice.own.publish('status', 'online');
  assert.equal((await alice.get(`${alice.userSpaceId}/status`)).value, 'online');
  assert.equal((await alice.own.get('status')).value, 'online');
});

test('qu.own.get()/publish() with no subpath addresses the Space root itself', async () => {
  const alice = await Qu.create();
  await alice.own.publish(undefined, { hello: 'root' });
  const direct = await alice.get(alice.userSpaceId);
  assert.deepEqual(direct.value, { hello: 'root' });
  assert.deepEqual((await alice.own.get()).value, { hello: 'root' });
});

test('qu.space(id) works for any known Space — reading another user\'s public profile fields', async () => {
  const alice = await Qu.create();
  const bob = await Qu.create({ runtime: alice.runtime });
  await bob.publishProfile({ alias: 'bobby' });

  const bobSpace = alice.space(bob.userSpaceId);
  assert.equal(bobSpace.id, bob.userSpaceId);
  assert.equal((await bobSpace.get('alias')).value, 'bobby');
});

test('qu.space(id) enforces the same write ACL as qu.publish(id, ...) would — no bypass', async () => {
  const alice = await Qu.create();
  const bob = await Qu.create({ runtime: alice.runtime });
  const aliceViaBob = bob.space(alice.userSpaceId);
  await assert.rejects(() => aliceViaBob.publish('status', 'hijacked'), /\[ACL\] Write denied/);
});

test('a guest\'s QuSpace throws on write, exactly like the guest itself', async () => {
  const guest = await Qu.create({ guest: true });
  await assert.rejects(() => guest.own.publish('x', 1), /Guest-Sessions haben kein Schreibrecht/);
});

test('createSpace() returns a QuSpace, not a raw string — but behaves like one everywhere a string id was expected', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = await alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });

  assert.ok(room instanceof QuSpace);
  assert.equal(typeof room.id, 'string');

  // via the handle itself:
  await room.publish('msg1', 'hallo über das Handle');
  assert.equal((await room.get('msg1')).value, 'hallo über das Handle');

  // passed DIRECTLY as an id where a plain string was expected (not interpolated) —
  // bob is a writer but not an admin, so this must target a subpath, not the
  // room's own manifest root (which only admins may rewrite):
  await bob.publish(`${room}/msg1b`, 'hallo direkt übergeben');
  assert.equal((await alice.get(`${room}/msg1b`)).value, 'hallo direkt übergeben');

  // interpolated into a template literal, the traditional style:
  await alice.publish(`${room}/msg2`, 'hallo interpoliert');
  assert.equal((await bob.query(`${room}/**`)).length, 3);

  // JSON-safe when nested inside other data:
  assert.deepEqual(JSON.parse(JSON.stringify({ room })), { room: room.id });
});

test('createSpace() handle is independently reconstructible via qu.space(existingId) — e.g. loading a room by its UUID from a link', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const room = await alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await alice.publish(room, { welcome: true });

  const carol = await Qu.create({ runtime: alice.runtime });
  const loaded = carol.space(room.id); // as if `room.id` arrived via a shared link
  assert.deepEqual((await loaded.get()).value, { welcome: true });
});

test('Qu.create({ mounts }) is sugar for constructing a QuStore — different prefixes on different adapters', async () => {
  // Combined with `plugins` in the same config object: the Spaces plugin's
  // bootstrap rule (no manifest yet -> anyone may write) is the simplest
  // way to get a generic, non-User-Space prefix writable for this check —
  // the point under test is mount routing, not ACL policy.
  const qu = await Qu.create({
    mounts: [
      { prefix: '', adapter: new MemoryAdapter() },
      { prefix: 'ephemeral/', adapter: new NullAdapter() },
    ],
    plugins: [createSpacesPlugin()],
  });
  await qu.publish('ephemeral/tick', 1);
  assert.equal(await qu.get('ephemeral/tick'), null, 'NullAdapter mount never stores, exactly like constructing the QuStore by hand would');

  await qu.publish(`${qu.userSpaceId}/status`, 'ok');
  assert.equal((await qu.get(`${qu.userSpaceId}/status`)).value, 'ok', 'the default (\'\') mount still persists normally');
});

test('Qu.create({ plugins }) auto-installs each plugin, equivalent to chaining .use() manually', async () => {
  const qu = await Qu.create({ plugins: [createSpacesPlugin()] });
  assert.equal(typeof qu.createSpace, 'function');
  const room = await qu.createSpace({ writers: [qu.fingerprint], readers: ['*'] });
  assert.ok(room instanceof QuSpace);
});

test('Qu.create({ store }) still takes precedence over mounts, unchanged', async () => {
  const store = new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
  const qu = await Qu.create({ store, mounts: [{ prefix: '', adapter: new NullAdapter() }] });
  await qu.publish(`${qu.userSpaceId}/x`, 1);
  assert.equal((await qu.get(`${qu.userSpaceId}/x`)).value, 1, 'store wins over mounts — data actually persisted, not silently dropped by the NullAdapter mounts would have used');
});
