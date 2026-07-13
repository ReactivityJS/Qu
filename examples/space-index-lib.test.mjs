import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import { setLabel, getLabel, registerSpace, listSpaces, onSpaceRegistered } from './space-index-lib.mjs';

test('setLabel()/getLabel(): a human-readable label lives as its own leaf, independent of the manifest', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const space = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await space.ready;

  assert.equal(await getLabel(space), null, 'no label set yet');
  await setLabel(space, 'Mein Board');
  assert.equal(await getLabel(space), 'Mein Board');

  // Confirms the doc comment's warning: passing `label` straight into
  // createSpace()'s opts would be silently dropped by buildManifest().
  const manifest = (await alice.get(space.id)).value;
  assert.equal('label' in manifest, false, 'the label is not part of the manifest itself');
});

test('an App-Space indexes multiple independently-ACL\'d sub-spaces (boards/lists) by label', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const mallory = await Qu.create({ runtime: alice.runtime });

  const appSpace = alice.createSpaceAt('app-space-index-demo', { writers: ['*'], readers: ['*'] });
  await appSpace.ready;

  const openBoard = alice.createSpace({ writers: ['*'], readers: ['*'] });
  await openBoard.ready;
  await setLabel(openBoard, 'Öffentliches Board');

  // A restricted (non-'*') readers list auto-encrypts (README Abschnitt 2) —
  // each recipient's encryption key must be discoverable first.
  await alice.publishProfile({ alias: 'alice' });
  await bob.publishProfile({ alias: 'bob' });
  const privateBoard = alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: [alice.fingerprint, bob.fingerprint] });
  await privateBoard.ready;
  await setLabel(privateBoard, 'Privates Board');

  const index = appSpace.get('boards');
  await registerSpace(index, 'Öffentliches Board', openBoard.id);
  await registerSpace(index, 'Privates Board', privateBoard.id);

  const entries = await listSpaces(index);
  assert.deepEqual(entries.map((e) => e.label), ['Privates Board', 'Öffentliches Board'], 'alphabetically sorted');
  assert.equal(entries.find((e) => e.label === 'Privates Board').spaceId, privateBoard.id);

  // Each sub-space keeps its OWN, fully independent ACL:
  await bob.get(privateBoard.id).get('items').set({ text: 'bob (member) darf schreiben' });
  await assert.rejects(() => mallory.get(privateBoard.id).get('items').set({ text: 'mallory versucht' }), /\[ACL\] Write denied/);
  await mallory.get(openBoard.id).get('items').set({ text: 'mallory darf hier schreiben' }); // unaffected by privateBoard's restriction

  // The index ENTRY itself (label + id) is only as private as the App-Space's
  // OWN readers — visible to mallory even for a board she cannot write/read:
  const malloryIndex = await listSpaces(mallory.get('app-space-index-demo').get('boards'));
  assert.equal(malloryIndex.length, 2, 'mallory sees both index entries — the App-Space itself is readers: [\'*\']');
});

test('onSpaceRegistered(): a live subscription to the index, not just a one-shot list', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const appSpace = alice.createSpaceAt('app-space-index-live-demo', { writers: ['*'], readers: ['*'] });
  await appSpace.ready;

  const seen = [];
  onSpaceRegistered(appSpace.get('lists'), (q) => seen.push(q.value.label));

  const list1 = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await list1.ready;
  await registerSpace(appSpace.get('lists'), 'Einkaufen', list1.id);

  const list2 = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await list2.ready;
  await registerSpace(appSpace.get('lists'), 'Arbeit', list2.id);

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen.sort(), ['Arbeit', 'Einkaufen']);
});
