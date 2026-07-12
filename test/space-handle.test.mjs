import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, QuSpace, QuStore, MemoryAdapter, NullAdapter, createSpacesPlugin, bindKey } from '../src/index.js';

test('a QuSpace exposes .runtime, so ui/bindings.js\'s bindKey() (needs runtime.nextTs() for its echo guard) works when passed a QuSpace directly, not just a Qu instance', async () => {
  const alice = await Qu.create();
  assert.equal(alice.own.runtime, alice.runtime);

  const listeners = new Map();
  const input = {
    value: '',
    addEventListener(event, fn) { listeners.set(event, fn); },
    removeEventListener() {},
  };
  const off = bindKey(alice.own.get('bio'), input); // alice.own.get('bio'), not alice — this used to throw "Cannot read properties of undefined (reading 'nextTs')"
  input.value = 'hello';
  await listeners.get('input')();
  assert.equal((await alice.own.get('bio')).value, 'hello');
  off();
});

test('qu.own is a QuSpace bound to the User-Space, relative paths resolve under it', async () => {
  const alice = await Qu.create();
  assert.equal(alice.own.id, alice.userSpaceId);
  assert.equal(String(alice.own), alice.userSpaceId);

  await alice.own.get('status').put('online');
  assert.equal((await alice.get(`${alice.userSpaceId}/status`)).value, 'online');
  assert.equal((await alice.own.get('status')).value, 'online');
});

test('qu.own.put()/get() with no subpath addresses the Space root itself', async () => {
  const alice = await Qu.create();
  await alice.own.put({ hello: 'root' });
  const direct = await alice.get(alice.userSpaceId);
  assert.deepEqual(direct.value, { hello: 'root' });
  assert.deepEqual((await alice.own).value, { hello: 'root' });
});

test('qu.get(id) works for any known Space — reading another user\'s public profile fields', async () => {
  const alice = await Qu.create();
  const bob = await Qu.create({ runtime: alice.runtime });
  await bob.own.get('alias').put('bobby');

  const bobSpace = alice.get(bob.userSpaceId);
  assert.equal(bobSpace.id, bob.userSpaceId);
  assert.equal((await bobSpace.get('alias')).value, 'bobby');
});

test('qu.get(id) enforces the same write ACL as qu.get(id).put(...) would — no bypass', async () => {
  const alice = await Qu.create();
  const bob = await Qu.create({ runtime: alice.runtime });
  const aliceViaBob = bob.get(alice.userSpaceId);
  await assert.rejects(() => aliceViaBob.get('status').put('hijacked'), /\[ACL\] Write denied/);
});

test('a guest\'s QuSpace throws on write, exactly like the guest itself', async () => {
  const guest = await Qu.create({ guest: true });
  await assert.rejects(() => guest.own.get('x').put(1), /Guest-Sessions haben kein Schreibrecht/);
});

test('createSpace() returns a QuSpace, not a raw string — but behaves like one everywhere a string id was expected', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const room = alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] }); // synchronous — see modules/spaces.js
  await room.ready; // wait for the manifest write to land — a plain "await room" is only a read and can race ahead of it

  assert.ok(room instanceof QuSpace);
  assert.equal(typeof room.id, 'string');

  // via the handle itself:
  await room.get('msg1').put('hallo über das Handle');
  assert.equal((await room.get('msg1')).value, 'hallo über das Handle');

  // passed DIRECTLY as an id where a plain string was expected (not interpolated) —
  // bob is a writer but not an admin, so this must target a subpath, not the
  // room's own manifest root (which only admins may rewrite):
  await bob.get(`${room}/msg1b`).put('hallo direkt übergeben');
  assert.equal((await alice.get(`${room}/msg1b`)).value, 'hallo direkt übergeben');

  // interpolated into a template literal, the traditional style:
  await alice.get(`${room}/msg2`).put('hallo interpoliert');
  assert.equal((await bob.session.query(`${room}/**`)).length, 3);

  // JSON-safe when nested inside other data:
  assert.deepEqual(JSON.parse(JSON.stringify({ room })), { room: room.id });
});

test('createSpace() handle is independently reconstructible via qu.get(existingId) — e.g. loading a room by its UUID from a link', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const room = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await room.ready; // wait for the manifest write to land — "await room" alone is a read and can race ahead of it
  await room.put({ welcome: true });

  const carol = await Qu.create({ runtime: alice.runtime });
  const loaded = carol.get(room.id); // as if `room.id` arrived via a shared link
  assert.deepEqual((await loaded).value, { welcome: true });
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
  await qu.get('ephemeral/tick').put(1);
  assert.equal(await qu.get('ephemeral/tick'), null, 'NullAdapter mount never stores, exactly like constructing the QuStore by hand would');

  await qu.get(`${qu.userSpaceId}/status`).put('ok');
  assert.equal((await qu.get(`${qu.userSpaceId}/status`)).value, 'ok', 'the default (\'\') mount still persists normally');
});

test('Qu.create({ plugins }) auto-installs each plugin, equivalent to chaining .use() manually', async () => {
  const qu = await Qu.create({ plugins: [createSpacesPlugin()] });
  assert.equal(typeof qu.createSpace, 'function');
  const room = qu.createSpace({ writers: [qu.fingerprint], readers: ['*'] });
  assert.ok(room instanceof QuSpace);
});

test('Qu.create({ store }) still takes precedence over mounts, unchanged', async () => {
  const store = new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
  const qu = await Qu.create({ store, mounts: [{ prefix: '', adapter: new NullAdapter() }] });
  await qu.get(`${qu.userSpaceId}/x`).put(1);
  assert.equal((await qu.get(`${qu.userSpaceId}/x`)).value, 1, 'store wins over mounts — data actually persisted, not silently dropped by the NullAdapter mounts would have used');
});
