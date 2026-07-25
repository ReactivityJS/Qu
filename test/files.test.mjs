import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuIdentity, QuSession, createLoopbackChannelPair,
  MemoryFileStorageAdapter, publishFile, reassembleFile, DefaultFileTransfer,
} from '../src/index.js';
import { toB64, fromB64 } from '../src/core/bytes.js';
import { makeRuntime, randomBytes } from './helpers.mjs';

test('a file is chunked, transferred, and reassembles byte-for-byte identical to the original', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const storageB = new MemoryFileStorageAdapter();
  const original = randomBytes(200_000); // forces multiple, content-distinct 64 KiB chunks

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f1', original, { name: 'test.bin', fileStorage: storageA });

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  await xferB.requestFile(manifestId);
  const manifest = (await rtB.get(manifestId)).value;
  assert.ok(manifest.chunks.length > 1, 'test fixture should span multiple chunks');

  const reassembled = await reassembleFile(storageB, manifest);
  assert.deepEqual(reassembled, original);
  assert.ok(await xferB.hasComplete(manifestId));

  xferA.close();
  xferB.close();
});

test('resuming a transfer only requests chunks that are actually still missing', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const storageB = new MemoryFileStorageAdapter();
  const original = randomBytes(200_000);

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f2', original, { name: 'test2.bin', fileStorage: storageA });
  const manifestQubit = await rtA.get(manifestId);
  await rtB.ingest(manifestQubit); // simulate the manifest having already synced earlier
  await storageB.putChunk(manifestQubit.value.chunks[0], await storageA.getChunk(manifestQubit.value.chunks[0])); // one chunk already present

  let chunkRequests = 0;
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const countingB = { ...chB, send: (msg) => { if (msg.type === 'qu.file.chunk.request') chunkRequests++; return chB.send(msg); } };
  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, countingB, storageB);

  await xferB.requestFile(manifestId);
  assert.equal(chunkRequests, manifestQubit.value.chunks.length - 1, 'must not re-request the chunk already present');

  xferA.close();
  xferB.close();
});

test('a chunk corrupted in transit is rejected by hash check and never persisted', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const storageB = new MemoryFileStorageAdapter();
  const original = randomBytes(200_000);

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f3', original, { name: 'test3.bin', fileStorage: storageA });

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const corruptingA = {
    ...chA,
    send: (msg) => {
      if (msg.type === 'qu.file.chunk.response' && msg.bytes) {
        const bytes = fromB64(msg.bytes);
        bytes[0] ^= 0xff;
        msg = { ...msg, bytes: toB64(bytes) };
      }
      return chA.send(msg);
    },
  };
  const xferA = new DefaultFileTransfer(rtA, corruptingA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  await assert.rejects(() => xferB.requestFile(manifestId));
  const manifest = (await rtB.get(manifestId)).value;
  assert.equal(await storageB.hasChunk(manifest.chunks[0]), false, 'a rejected chunk must never be written to storage');

  xferA.close();
  xferB.close();
});

test('clicking "download" before the sender has the chunk ready retries with backoff instead of failing on the first miss', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const storageB = new MemoryFileStorageAdapter();
  const bytes = new TextEncoder().encode('hello, downloaded slightly too early');

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f4', bytes, { name: 'f4.txt', fileStorage: storageA });
  const manifestValue = (await rtA.get(manifestId)).value;
  const chunkHash = manifestValue.chunks[0];

  // Simulate the sender not having the chunk ready yet (e.g. the relay is
  // still mirroring it from elsewhere) — remove it, then "arrive" shortly
  // after the receiver's first attempt.
  await storageA.deleteChunk(chunkHash);

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  setTimeout(() => { storageA.putChunk(chunkHash, bytes); }, 500); // "arrives" mid-retry

  const progressSeen = [];
  await xferB.requestFile(manifestId, { onProgress: (p) => progressSeen.push(p.attempt) });

  const received = await reassembleFile(storageB, manifestValue);
  assert.deepEqual(received, bytes, 'the file must still be retrieved once it becomes available, without a second manual click');
  assert.ok(progressSeen.length >= 1, 'at least one retry attempt should have been observable');

  xferA.close();
  xferB.close();
});

test('waitUntilReady(): onProgress reports real have/total chunk counts, not just "not ready yet"', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const storageB = new MemoryFileStorageAdapter();
  const original = randomBytes(200_000); // forces multiple chunks, same fixture as the first test above

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f6', original, { name: 'f6.bin', fileStorage: storageA });
  const manifest = (await rtA.get(manifestId)).value;
  assert.ok(manifest.chunks.length > 1, 'test fixture should span multiple chunks');
  await storageA.deleteChunk(manifest.chunks[manifest.chunks.length - 1]); // one chunk still "in flight" — not ready yet

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  const progressSeen = [];
  const ready = await xferB.waitUntilReady(manifestId, { intervalMs: 50, maxWaitMs: 200, onProgress: (p) => progressSeen.push(p) });
  assert.equal(ready, false);
  assert.ok(progressSeen.length >= 1, 'at least one progress tick expected');
  for (const p of progressSeen) {
    assert.equal(p.total, manifest.chunks.length, 'total must be the real chunk count, known from the very first check');
    assert.equal(p.have, manifest.chunks.length - 1, 'have must reflect exactly the chunks actually present on the peer, not just a boolean');
  }

  xferA.close();
  xferB.close();
});

test('waitUntilReady(): resolves true once the peer actually has every chunk, without transferring any bytes itself', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const storageB = new MemoryFileStorageAdapter();
  const bytes = new TextEncoder().encode('readiness check payload');

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f5', bytes, { name: 'f5.txt', fileStorage: storageA });
  const chunkHash = (await rtA.get(manifestId)).value.chunks[0];
  await storageA.deleteChunk(chunkHash); // not ready yet

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  let ready = await xferB.waitUntilReady(manifestId, { intervalMs: 100, maxWaitMs: 300 });
  assert.equal(ready, false, 'not ready yet, and must not have downloaded anything either');
  assert.equal(await storageB.hasChunk(chunkHash), false);

  await storageA.putChunk(chunkHash, bytes.subarray(0, bytes.length)); // arrives late — reuse same bytes for simplicity, only presence matters here
  ready = await xferB.waitUntilReady(manifestId, { intervalMs: 100, maxWaitMs: 1000 });
  assert.equal(ready, true);
  assert.equal(await storageB.hasChunk(chunkHash), false, 'waitUntilReady must never transfer chunk bytes itself');

  xferA.close();
  xferB.close();
});

test('hasComplete() answers from local storage only — no network round-trip, so a sender sees their own upload as immediately ready', async () => {
  const rtA = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const bytes = new TextEncoder().encode('own upload');

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f6', bytes, { name: 'f6.txt', fileStorage: storageA });

  // No channel/peer involved at all — hasComplete() must not need one.
  const xfer = new DefaultFileTransfer(rtA, createLoopbackChannelPair().a, storageA);
  assert.equal(await xfer.hasComplete(manifestId), true);
  xfer.close();
});
