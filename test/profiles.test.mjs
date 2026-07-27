import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, createProfilesPlugin, DIRECTORY_ID } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

async function makePeer(runtime) {
  const qu = runtime ? await Qu.create({ runtime }) : (await Qu.create()).use(createSpacesPlugin());
  return qu.use(createProfilesPlugin());
}

test('setProfileAttr()/getProfileAttr()/listProfileAttrs(): plain custom attributes, per-field like alias/avatar', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  await alice.setProfileAttr('bio', 'hello world');
  await alice.setProfileAttr('website', 'https://example.com');

  assert.equal(await bob.getProfileAttr(alice.fingerprint, 'bio'), 'hello world');
  const all = await bob.listProfileAttrs(alice.fingerprint);
  assert.deepEqual(all, {
    bio: { value: 'hello world', private: false },
    website: { value: 'https://example.com', private: false },
  });
});

test('getProfileAttr(): never-set or deleted attribute reads as null, not an error', async () => {
  const alice = await makePeer();
  assert.equal(await alice.getProfileAttr(alice.fingerprint, 'never-set'), null);

  await alice.setProfileAttr('temp', 'x');
  await alice.deleteProfileAttr('temp');
  assert.equal(await alice.getProfileAttr(alice.fingerprint, 'temp'), null);
  assert.deepEqual(await alice.listProfileAttrs(alice.fingerprint), {}, 'a deleted attribute must not appear in the listing either');
});

test('setProfileAttr(): encryptFor restricts a single field, unrelated plain fields stay untouched', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  const mallory = await makePeer(alice.runtime);
  await Promise.all([alice, bob, mallory].map((qu) => qu.publishProfile()));

  await alice.setProfileAttr('secret-note', 'only bob should read this', { encryptFor: [alice.fingerprint, bob.fingerprint] });
  await alice.setProfileAttr('bio', 'public bio');

  assert.equal(await bob.getProfileAttr(alice.fingerprint, 'secret-note'), 'only bob should read this');
  assert.equal(await mallory.getProfileAttr(alice.fingerprint, 'secret-note'), null, 'not an addressed recipient');
  assert.equal(await mallory.getProfileAttr(alice.fingerprint, 'bio'), 'public bio', 'the plain field is unaffected by the other field\'s encryption');
});

test('listProfileAttrs(): `private` reflects each field\'s CURRENT encryption for the owner\'s own view — never falsely `false` for a field a non-owner simply could not decrypt', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  await Promise.all([alice, bob].map((qu) => qu.publishProfile()));

  // "Privat" (nur für Alice selbst, s. examples/people's attrPrivateToggle) —
  // encryptFor: [nur die eigene Identität].
  await alice.setProfileAttr('diary', 'dear diary', { encryptFor: [alice.fingerprint] });
  await alice.setProfileAttr('bio', 'public bio');

  const own = await alice.listProfileAttrs(alice.fingerprint);
  assert.deepEqual(own, {
    diary: { value: 'dear diary', private: true },
    bio: { value: 'public bio', private: false },
  });

  // Bob (nicht adressiert für "diary") sieht dieses Feld gar nicht erst —
  // kein `private: false`, das fälschlich "öffentlich" vorgäbe.
  const bobsView = await bob.listProfileAttrs(alice.fingerprint);
  assert.deepEqual(bobsView, { bio: { value: 'public bio', private: false } });
});

test('onProfileAttrsChange(): live subscription fires for new/changed/deleted attributes', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  const seen = [];
  bob.onProfileAttrsChange(alice.fingerprint, (q) => seen.push(q.value));

  await alice.setProfileAttr('bio', 'v1');
  await alice.setProfileAttr('bio', 'v2');
  await alice.deleteProfileAttr('bio');
  await wait();

  assert.deepEqual(seen, ['v1', 'v2', null]);
});

test('directory: an identity is invisible by default, appears only after setDirectoryVisible(true), disappears again on false', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  assert.deepEqual(await bob.listDirectory(), [], 'nobody has opted in yet');

  await alice.setDirectoryVisible(true);
  const listed = await bob.listDirectory();
  assert.deepEqual(listed, [{ fingerprint: alice.fingerprint }]);

  await alice.setDirectoryVisible(false);
  assert.deepEqual(await bob.listDirectory(), [], 'explicitly hidden again');
});

test('directory: listDirectory() dedupes by the verified writer, not by path — a forged entry cannot inject a fake extra row', async () => {
  const alice = await makePeer();
  const mallory = await makePeer(alice.runtime);
  await alice.setDirectoryVisible(true);

  // Mallory writes a bogus entry at Alice's expected path key.
  await mallory.get(`${DIRECTORY_ID}/entries/${alice.fingerprint}`).put({ visible: true });

  const listed = await alice.listDirectory();
  assert.equal(listed.length, 1, 'only one row for alice — mallory\'s forged write is attributed to mallory (a hidden identity), not alice');
});

test('onDirectoryChange(): live subscription fires when someone opts in or out', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  const seen = [];
  bob.onDirectoryChange((q) => seen.push({ writer: q.writer, visible: q.value?.visible }));

  await alice.setDirectoryVisible(true);
  await wait();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].writer, alice.fingerprint);
  assert.equal(seen[0].visible, true);
});
