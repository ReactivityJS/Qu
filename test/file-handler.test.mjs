import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, MemoryFileStorageAdapter, createLoopbackChannelPair,
  createFileHandlerPlugin, resolveReference, fileRef,
} from '../src/index.js';

// Every manifest id below lives under the sharing Qu's own User-Space —
// the Core default only ever grants writes there (core/identity-acl.js),
// and no Spaces plugin is needed for a reader on another Runtime: read-ACL
// for a User-Space defaults to readers: ['*'], and write-ACL for a manifest
// genuinely signed by its owner passes on any Runtime (the check is
// id-owner-based, not "who's asking locally").

test('shareFile()/resolveFileRef() round-trip locally when every chunk is already present', async () => {
  const fileStorage = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createFileHandlerPlugin({ fileStorage }));
  const bytes = new TextEncoder().encode('hello file handler');

  const { manifestId, fileRef: ref } = await alice.shareFile(`${alice.userSpaceId}/files/f1`, bytes);
  assert.equal(ref, `file://${manifestId}`);

  const received = await alice.resolveFileRef(ref);
  assert.deepEqual(received, bytes);
});

test('a guest cannot shareFile() — the same guard the old hardcoded Qu.shareFile() had', async () => {
  const fileStorage = new MemoryFileStorageAdapter();
  const guest = (await Qu.create({ guest: true })).use(createFileHandlerPlugin({ fileStorage }));
  await assert.rejects(() => guest.shareFile(`${guest.userSpaceId}/files/f1`, new Uint8Array([1, 2, 3])));
});

test('resolveFileRef() throws when chunks are missing locally and no fileTransfer is supplied', async () => {
  const aliceFiles = new MemoryFileStorageAdapter();
  const bobFiles = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createFileHandlerPlugin({ fileStorage: aliceFiles }));
  const bob = (await Qu.create({ runtime: alice.runtime })).use(createFileHandlerPlugin({ fileStorage: bobFiles }));

  const { fileRef: ref } = await alice.shareFile(`${alice.userSpaceId}/files/f1`, new TextEncoder().encode('alice only'));
  await assert.rejects(() => bob.resolveFileRef(ref), /chunk\(s\) missing locally/);
});

test('resolveFileRef() fetches missing chunks via a supplied fileTransfer, then reassembles', async () => {
  const aliceFiles = new MemoryFileStorageAdapter();
  const bobFiles = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createFileHandlerPlugin({ fileStorage: aliceFiles }));
  const bob = (await Qu.create({ runtime: alice.runtime })).use(createFileHandlerPlugin({ fileStorage: bobFiles }));

  const bytes = new TextEncoder().encode('transferred over a channel, not just reassembled locally');
  const { fileRef: ref } = await alice.shareFile(`${alice.userSpaceId}/files/f1`, bytes);

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferAlice = alice.fileTransfer(chA); // defaults to aliceFiles, the plugin's own fileStorage
  const xferBob = bob.fileTransfer(chB);

  const received = await bob.resolveFileRef(ref, { fileTransfer: xferBob });
  assert.deepEqual(received, bytes);

  xferAlice.close();
  xferBob.close();
});

test('a file:// reference resolves to real bytes end-to-end when ReferenceHandler is given a FileHandler', async () => {
  const fileStorage = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createFileHandlerPlugin({ fileStorage }));
  const bytes = new TextEncoder().encode('composes with obj://key://');

  const { manifestId } = await alice.shareFile(`${alice.userSpaceId}/files/f1`, bytes);
  const fileHandler = createFileHandlerPlugin({ fileStorage });
  const resolved = await resolveReference(alice, fileRef(manifestId), { fileHandler });
  assert.deepEqual(resolved, bytes);
});
