import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import {
  createIncognitoIdentity, listIncognitoIdentities, getIncognitoIdentity, deleteIncognitoIdentity, enterIncognito,
} from '../src/modules/incognito-identity.js';

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
