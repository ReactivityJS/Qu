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

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f1', original, { name: 'test.bin', fileStorage: storageA, chunkSize: 64 * 1024 }); // explicit — decouple this test's chunk-count assumptions from manifest.js's actual DEFAULT_CHUNK_SIZE

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

test('requestFile() fetches chunks concurrently, not strictly one at a time', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const original = randomBytes(700_000); // ~11 chunks @ 64 KiB — comfortably more than the default concurrency window (6)

  // Wraps a real MemoryFileStorageAdapter, delaying every getChunk() by a
  // fixed amount and tracking how many are in flight AT ONCE — a strictly
  // sequential requestFile() would never see more than 1 active; the
  // whole point of this test is to prove that's no longer true.
  const real = new MemoryFileStorageAdapter();
  let active = 0;
  let peakActive = 0;
  const slowStorageA = {
    async putChunk(hash, bytes) { return real.putChunk(hash, bytes); },
    async hasChunk(hash) { return real.hasChunk(hash); },
    async deleteChunk(hash) { return real.deleteChunk(hash); },
    async getChunk(hash) {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return real.getChunk(hash);
    },
  };

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f-concurrent', original, { name: 'concurrent.bin', fileStorage: real, chunkSize: 64 * 1024 }); // explicit — see first test's doc
  const manifest = (await rtA.get(manifestId)).value;
  assert.ok(manifest.chunks.length >= 8, 'test fixture should span enough chunks to make concurrency observable');

  const storageB = new MemoryFileStorageAdapter();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferA = new DefaultFileTransfer(rtA, chA, slowStorageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  await xferB.requestFile(manifestId);

  assert.ok(peakActive > 1, `expected multiple chunk requests in flight at once, saw a peak of ${peakActive}`);

  xferA.close();
  xferB.close();
});

test('requestFile() batches receive-side writes via putChunks() when the adapter offers it, instead of one storage transaction per chunk', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  const original = randomBytes(2_500_000); // enough chunks to force multiple WRITE_BATCH_SIZE-sized flushes plus a trailing partial batch

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f-batched', original, { name: 'batched.bin', fileStorage: storageA, chunkSize: 64 * 1024 }); // explicit — see first test's doc
  const manifest = (await rtA.get(manifestId)).value;
  assert.ok(manifest.chunks.length > 32, 'test fixture should span more than one write batch (WRITE_BATCH_SIZE = 32)');

  // A receive-side adapter that offers putChunks() — real chunk storage
  // backed by a plain MemoryFileStorageAdapter, only wrapped to record how
  // it was actually called.
  const real = new MemoryFileStorageAdapter();
  let putChunkCalls = 0;
  const batchSizes = [];
  const storageB = {
    async putChunk(hash, bytes) { putChunkCalls++; return real.putChunk(hash, bytes); },
    async putChunks(entries) { batchSizes.push(entries.length); for (const { hash, bytes } of entries) await real.putChunk(hash, bytes); },
    async getChunk(hash) { return real.getChunk(hash); },
    async hasChunk(hash) { return real.hasChunk(hash); },
    async deleteChunk(hash) { return real.deleteChunk(hash); },
  };

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  await xferB.requestFile(manifestId);

  assert.equal(putChunkCalls, 0, 'when the adapter supports putChunks(), the single-chunk putChunk() must never be used on the receive path');
  assert.ok(batchSizes.length >= 2, `expected at least 2 batches for ${manifest.chunks.length} chunks, saw ${batchSizes.length}`);
  assert.equal(batchSizes.reduce((a, b) => a + b, 0), manifest.chunks.length, 'every chunk must have been written exactly once across all batches');
  for (const size of batchSizes) assert.ok(size <= 32, `no batch may exceed WRITE_BATCH_SIZE (32), saw ${size}`);

  const reassembled = await reassembleFile(real, manifest);
  assert.deepEqual(reassembled, original, 'batched writes must still produce byte-identical data');

  xferA.close();
  xferB.close();
});

test('requestFile() fetches a hash that appears at multiple manifest positions only once', async () => {
  const rtA = makeRuntime();
  const rtB = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessA = new QuSession(rtA, { identity: alice });
  const storageA = new MemoryFileStorageAdapter();
  // Two byte-for-byte identical 64 KiB blocks — content-addressing means
  // they hash to the SAME value, so the manifest's `chunks` array ends up
  // with that hash at two DIFFERENT positions (this is legitimate, not
  // malformed — e.g. two identical images anywhere in one upload).
  const block = randomBytes(65536);
  const original = new Uint8Array(block.length * 2);
  original.set(block, 0);
  original.set(block, block.length);

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f-dup', original, { name: 'dup.bin', fileStorage: storageA, chunkSize: 65536 }); // explicit — this test relies on splitting into EXACTLY two 64 KiB blocks
  const manifest = (await rtA.get(manifestId)).value;
  assert.equal(manifest.chunks.length, 2, 'test fixture should produce exactly two chunk entries');
  assert.equal(manifest.chunks[0], manifest.chunks[1], 'both entries must share the same hash — that is the whole point of this test');

  const storageB = new MemoryFileStorageAdapter();
  const { a: chA, b: chB } = createLoopbackChannelPair();
  let chunkRequestCount = 0;
  const originalSend = chB.send.bind(chB);
  chB.send = async (msg) => { if (msg.type === 'qu.file.chunk.request') chunkRequestCount++; return originalSend(msg); };

  const xferA = new DefaultFileTransfer(rtA, chA, storageA);
  const xferB = new DefaultFileTransfer(rtB, chB, storageB);

  await xferB.requestFile(manifestId);

  assert.equal(chunkRequestCount, 1, 'a hash appearing twice in the manifest must only be requested once over the wire');
  const reassembled = await reassembleFile(storageB, manifest);
  assert.deepEqual(reassembled, original, 'both positions must still reassemble correctly from the single fetched copy');

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

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f2', original, { name: 'test2.bin', fileStorage: storageA, chunkSize: 64 * 1024 }); // explicit — see first test's doc
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

  const { manifestId } = await publishFile(sessA, 'chat/room1/files/f6', original, { name: 'f6.bin', fileStorage: storageA, chunkSize: 64 * 1024 }); // explicit — see first test's doc
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
