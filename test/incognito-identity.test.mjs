import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import {
  createIncognitoIdentity, listIncognitoIdentities, getIncognitoIdentity, deleteIncognitoIdentity, enterIncognito,
  saveIncognitoIdentity, removeIncognitoIdentity, loadIncognitoStore, onIncognitoIdentitiesChange, createIncognitoPlugin,
} from '../src/modules/incognito-identity.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('createIncognitoIdentity(): generates a fresh, independent identity every call', async () => {
  const a = await createIncognitoIdentity('Kalender-Alias 1');
  const b = await createIncognitoIdentity('Kalender-Alias 2');
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(a.alias, 'Kalender-Alias 1');
  assert.ok(a.keys.signPub && a.keys.signPriv && a.keys.encPub && a.keys.encPriv, 'keys have the exact QuIdentity#exportKeys() shape');
});

test('createIncognitoIdentity(): rejects a missing/empty alias', async () => {
  await assert.rejects(() => createIncognitoIdentity(''));
  await assert.rejects(() => createIncognitoIdentity());
});

test('listIncognitoIdentities()/getIncognitoIdentity()/deleteIncognitoIdentity(): pure round-trip over a plain store object, without mutating it', async () => {
  const entry1 = await createIncognitoIdentity('Alias 1');
  const entry2 = await createIncognitoIdentity('Alias 2');
  const store = {
    [entry1.alias]: { fingerprint: entry1.fingerprint, keys: entry1.keys, createdAt: entry1.createdAt },
    [entry2.alias]: { fingerprint: entry2.fingerprint, keys: entry2.keys, createdAt: entry2.createdAt },
  };

  const listed = listIncognitoIdentities(store);
  assert.equal(listed.length, 2);
  assert.ok(listed.every((e) => e.keys === undefined), 'the list view never exposes private key material');
  assert.deepEqual(new Set(listed.map((e) => e.alias)), new Set(['Alias 1', 'Alias 2']));

  const got = getIncognitoIdentity(store, 'Alias 1');
  assert.equal(got.fingerprint, entry1.fingerprint);
  assert.ok(got.keys, 'getIncognitoIdentity() DOES include keys — it is the lookup enterIncognito() needs');

  assert.equal(getIncognitoIdentity(store, 'does-not-exist'), null);

  const nextStore = deleteIncognitoIdentity(store, 'Alias 1');
  assert.equal(store['Alias 1'] !== undefined, true, 'the original store object is never mutated in place');
  assert.equal(nextStore['Alias 1'], undefined);
  assert.ok(nextStore['Alias 2'], 'deleting one alias leaves the other untouched');

  const noopStore = deleteIncognitoIdentity(nextStore, 'never-existed');
  assert.deepEqual(noopStore, nextStore, 'deleting an unknown alias is a harmless no-op, same as removeFromRole()');
});

test('enterIncognito(): returns a fully independent Qu instance sharing the SAME Runtime, with its own fingerprint', async () => {
  const main = await Qu.create();
  const stored = await createIncognitoIdentity('Kalender-Alias');

  const incognito = await enterIncognito(main, stored);
  assert.notEqual(incognito.fingerprint, main.fingerprint);
  assert.equal(incognito.fingerprint, stored.fingerprint);
  assert.equal(incognito.runtime, main.runtime, 'same Runtime/Store — a shared local cache, not a second isolated instance');
});

test('enterIncognito(): automatically inherits whichever plugins the Runtime\'s first creator installed, same as any other identity sharing that Runtime', async () => {
  const main = (await Qu.create({ plugins: [createSpacesPlugin()] }));
  const stored = await createIncognitoIdentity('Kalender-Alias');
  const incognito = await enterIncognito(main, stored);

  assert.equal(typeof incognito.createSpace, 'function', 'createSpace() sugar is available without re-installing the plugin');
  const room = incognito.createSpace({ writers: [incognito.fingerprint], readers: ['*'] });
  await room.ready;
  assert.deepEqual((await incognito.get(room.id)).value.writers, [incognito.fingerprint]);
});

test('enterIncognito(): a Space created under the incognito identity mentions only the incognito fingerprint, never the main one', async () => {
  const owner = await Qu.create({ plugins: [createSpacesPlugin()] });
  const stored = await createIncognitoIdentity('Kalender-Alias');
  const incognito = await enterIncognito(owner, stored);

  const room = incognito.createSpace({ writers: [incognito.fingerprint], readers: ['*'] });
  await room.ready;
  await incognito.get(room.id).get('note').put('hello from incognito');

  const manifest = await owner.get(room.id);
  const note = await owner.get(`${room.id}/note`);
  assert.deepEqual(manifest.value.writers, [incognito.fingerprint]);
  assert.equal(note.writer, incognito.fingerprint);
  assert.equal(manifest.value.writers.includes(owner.fingerprint), false, 'the main identity never appears in the incognito Space at all');
});

test('enterIncognito(): rejects a store entry with no keys', async () => {
  const main = await Qu.create();
  await assert.rejects(() => enterIncognito(main, { alias: 'broken' }));
});

test('saveIncognitoIdentity()/loadIncognitoStore(): persists under the owner\'s own Space, encrypted-to-self, and round-trips through the exact plain-object shape the pure functions expect', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const entry = await createIncognitoIdentity('Forum-Alias');
  await saveIncognitoIdentity(owner, entry);

  const store = await loadIncognitoStore(owner);
  assert.deepEqual(Object.keys(store), ['Forum-Alias']);
  assert.equal(store['Forum-Alias'].fingerprint, entry.fingerprint);
  assert.deepEqual(store['Forum-Alias'].keys, entry.keys);

  // The pure functions from earlier work UNCHANGED on top of this persisted store.
  const listed = listIncognitoIdentities(store);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].alias, 'Forum-Alias');
  const got = getIncognitoIdentity(store, 'Forum-Alias');
  assert.equal(got.fingerprint, entry.fingerprint);
});

test('saveIncognitoIdentity(): is actually encrypted — a third party reading the raw QuBit never sees the plaintext keys', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const entry = await createIncognitoIdentity('Secret-Alias');
  await saveIncognitoIdentity(owner, entry);

  // runtime.get() is the RAW store read, bypassing Session's decrypt (the
  // `.encrypted` flag listProfileAttrs() reports is a SESSION-level, post-
  // decrypt annotation, not present on a raw qubit) — so the meaningful
  // check here is simply that the stored `value` is NOT the plaintext
  // payload (i.e. it's some opaque ciphertext envelope instead).
  const raw = await owner.runtime.get(`${owner.own.id}/incognito/Secret-Alias`);
  assert.ok(raw, 'a stored QuBit must exist at that id');
  assert.notDeepEqual(raw.value, { fingerprint: entry.fingerprint, keys: entry.keys, createdAt: entry.createdAt }, 'the raw stored value must not be the plaintext payload');
});

test('loadIncognitoStore(): multiple aliases, and a second device (same identity, same Runtime/Store) sees the same store', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const entryA = await createIncognitoIdentity('Alias A');
  const entryB = await createIncognitoIdentity('Alias B');
  await saveIncognitoIdentity(owner, entryA);
  await saveIncognitoIdentity(owner, entryB);

  // A "second device" holding the same identity is modeled as a second Qu
  // instance sharing the same runtime/store, same convention as enterIncognito()'s
  // own doc comment on "a second, independent identity sharing one Runtime" —
  // here it's the SAME identity, proving replicated content is readable there.
  const secondDevice = await Qu.create({ runtime: owner.runtime, identity: await owner.exportKeys() });
  const store = await loadIncognitoStore(secondDevice);
  assert.deepEqual(new Set(Object.keys(store)), new Set(['Alias A', 'Alias B']));
});

test('removeIncognitoIdentity(): tombstones an alias — loadIncognitoStore() and onIncognitoIdentitiesChange() both treat it as absent', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  // Listener registered BEFORE anything exists at this path, so there's no
  // "initial catch-up vs. immediate write" race to reason about — every
  // event below is a genuinely live delivery, in order.
  const seen = [];
  onIncognitoIdentitiesChange(owner, (q) => seen.push(q.value));

  const entry = await createIncognitoIdentity('To-Remove');
  await saveIncognitoIdentity(owner, entry);
  await wait();
  assert.ok((await loadIncognitoStore(owner))['To-Remove']);

  await removeIncognitoIdentity(owner, 'To-Remove');
  await wait();

  assert.equal((await loadIncognitoStore(owner))['To-Remove'], undefined);
  assert.deepEqual(seen.at(-1), null, 'the live subscription must see the tombstone (null) as its own event');
});

test('onIncognitoIdentitiesChange(): fires for both already-persisted and newly-saved aliases', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const existing = await createIncognitoIdentity('Already-There');
  await saveIncognitoIdentity(owner, existing);

  const seenAliases = [];
  onIncognitoIdentitiesChange(owner, (q) => seenAliases.push(q.id.split('/').pop()), { initial: true });
  await wait();
  assert.deepEqual(seenAliases, ['Already-There']);

  const fresh = await createIncognitoIdentity('New-One');
  await saveIncognitoIdentity(owner, fresh);
  await wait();
  assert.deepEqual(seenAliases.sort(), ['Already-There', 'New-One']);
});

test('qu.createIncognitoIdentity()/qu.saveIncognitoIdentity()/etc.: the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createIncognitoPlugin());
  const entry = await owner.createIncognitoIdentity('Plugin-Alias');
  await owner.saveIncognitoIdentity(entry);

  const store = await owner.loadIncognitoStore();
  assert.ok(store['Plugin-Alias']);

  const incognito = await owner.enterIncognito(store['Plugin-Alias']);
  assert.equal(incognito.fingerprint, entry.fingerprint);

  await owner.removeIncognitoIdentity('Plugin-Alias');
  assert.equal((await owner.loadIncognitoStore())['Plugin-Alias'], undefined);
});
