import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, createSpacesPlugin, createFileHandlerPlugin, MemoryFileStorageAdapter,
  publishFile, reassembleFile, readFileMeta, QuIdentity,
} from '../src/index.js';
import { encryptBytesFor, decryptBytesWith } from '../src/core/crypto.js';
import { randomBytes } from './helpers.mjs';

test('encryptBytesFor()/decryptBytesWith() round-trip for the addressed recipient, and reject everyone else', async () => {
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const original = randomBytes(5000);

  const { envelope, ciphertext } = await encryptBytesFor(
    [{ fingerprint: bob.fingerprint, ecdhPublicKey: bob.encryptionKey }],
    original,
  );
  assert.notDeepEqual(ciphertext, original, 'ciphertext must not equal the plaintext');

  const decrypted = await decryptBytesWith(bob, envelope, ciphertext);
  assert.deepEqual(decrypted, original, 'the addressed recipient must recover the exact original bytes');

  const forOutsider = await decryptBytesWith(outsider, envelope, ciphertext);
  assert.equal(forOutsider, undefined, 'a fingerprint with no wrapped-key entry gets undefined, not a thrown error or garbage bytes');

  const forAlice = await decryptBytesWith(alice, envelope, ciphertext);
  assert.equal(forAlice, undefined, 'the sender is not automatically a recipient unless explicitly included');
});

test('publishFile()+reassembleFile() with encryptFor: file content is genuinely encrypted at rest, and reassembles correctly for an addressed recipient', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: owner.runtime });
  const outsider = await Qu.create({ runtime: owner.runtime });
  await Promise.all([owner, bob, outsider].map((qu) => qu.publishProfile()));

  const readers = [owner.fingerprint, bob.fingerprint];
  const room = owner.createSpace({ writers: readers, readers: ['*'] }); // '*' readers, like the chat app's DM rooms — confidentiality must come from encryptFor, not the ACL
  await room.ready;

  const storage = new MemoryFileStorageAdapter();
  const original = randomBytes(150_000); // multiple chunks
  const { manifestId, manifest } = await publishFile(owner.session, `${room.id}/files/f1`, original, {
    name: 'geheim.bin', mime: 'application/octet-stream', fileStorage: storage, encryptFor: readers,
  });

  assert.ok(manifest.contentEncryption, 'manifest must record how to decrypt the content');
  assert.ok(manifest.metaEncryption, 'name/mime/size must be encrypted too, separately from the content');
  assert.equal(manifest.name, undefined, 'plaintext name must not leak onto the manifest when encrypted');
  assert.equal(manifest.mime, undefined, 'plaintext mime must not leak onto the manifest when encrypted');
  assert.equal(manifest.size, undefined, 'plaintext size must not leak onto the manifest when encrypted');

  const metaForBob = await readFileMeta(manifest, bob.identity);
  assert.deepEqual(metaForBob, { name: 'geheim.bin', mime: 'application/octet-stream', size: original.length }, 'the addressed recipient can read the real metadata, with size staying the PLAINTEXT length');

  const metaForOutsider = await readFileMeta(manifest, outsider.identity);
  assert.equal(metaForOutsider, undefined, 'a non-recipient identity cannot decrypt the metadata either');

  await assert.rejects(
    () => readFileMeta(manifest), // no identity at all
    /identity is required/,
    'reading encrypted metadata without any identity must fail loudly',
  );

  // The stored chunk bytes themselves must not be the plaintext — verify
  // directly against the storage adapter, not just via reassembleFile()
  // (which would hide a bug that never actually encrypted anything).
  const firstChunkStored = await storage.getChunk(manifest.chunks[0]);
  const firstChunkPlain = original.subarray(0, firstChunkStored.length);
  assert.notDeepEqual(firstChunkStored, firstChunkPlain, 'stored chunk bytes must be ciphertext, not the original plaintext');

  const reassembledForBob = await reassembleFile(storage, manifest, bob.identity);
  assert.deepEqual(reassembledForBob, original, 'the addressed recipient must recover the exact original file');

  const reassembledForOutsider = await reassembleFile(storage, manifest, outsider.identity);
  assert.equal(reassembledForOutsider, undefined, 'a non-recipient identity cannot decrypt the content, even with the raw chunks in hand');

  await assert.rejects(
    () => reassembleFile(storage, manifest), // no identity at all
    /identity is required/,
    'reassembling an encrypted file without any identity must fail loudly, not silently return ciphertext as if it were the real file',
  );
  void manifestId;
});

test('publishFile() without encryptFor stays plaintext, unchanged from before this feature existed', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const storage = new MemoryFileStorageAdapter();
  const original = randomBytes(1000);
  const { manifest } = await publishFile(owner.session, 'plain-file', original, { name: 'offen.bin', fileStorage: storage });

  assert.equal(manifest.contentEncryption, undefined, 'no contentEncryption field when encryptFor was never given');
  assert.equal(manifest.metaEncryption, undefined, 'no metaEncryption field when encryptFor was never given');
  assert.deepEqual(await readFileMeta(manifest), { name: 'offen.bin', mime: 'application/octet-stream', size: original.length }, 'readFileMeta() works without an identity when the manifest was never encrypted');
  const firstChunk = await storage.getChunk(manifest.chunks[0]);
  assert.deepEqual(firstChunk, original.subarray(0, firstChunk.length), 'chunk bytes are exactly the plaintext, exactly as before');

  const reassembled = await reassembleFile(storage, manifest); // no identity needed — never was
  assert.deepEqual(reassembled, original);
});

test('createFileHandlerPlugin(): qu.shareFile()/resolveFileRef() with encryptFor works end-to-end through the higher-level plugin API too', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: owner.runtime });
  await Promise.all([owner, bob].map((qu) => qu.publishProfile()));
  const readers = [owner.fingerprint, bob.fingerprint];
  const room = owner.createSpace({ writers: readers, readers: ['*'] });
  await room.ready;

  const storage = new MemoryFileStorageAdapter();
  owner.use(createFileHandlerPlugin({ fileStorage: storage }));
  bob.use(createFileHandlerPlugin({ fileStorage: storage })); // shared runtime + shared MemoryFileStorageAdapter stands in for "already replicated"

  const original = randomBytes(2000);
  const { fileRef } = await owner.shareFile(`${room.id}/files/f2`, original, { name: 'geheim2.bin', encryptFor: readers });

  const bytesForBob = await bob.resolveFileRef(fileRef);
  assert.deepEqual(bytesForBob, original);
});
