import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { FileSystemStorageAdapter } from '../src/adapters/node-fs.js';
import { FileSystemFileStorageAdapter } from '../src/adapters/node-fs-file-storage.js';

async function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `qu-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

test('FileSystemStorageAdapter: round-trip get/put/getAll respects prefix', async () => {
  const dir = await tmpDir('store');
  const adapter = new FileSystemStorageAdapter(path.join(dir, 'log.ndjson'));

  await adapter.put('room/msgs/a', { id: 'room/msgs/a', value: 'hi', ts: 1 });
  await adapter.put('room/msgs/b', { id: 'room/msgs/b', value: 'yo', ts: 2 });
  await adapter.put('other/x', { id: 'other/x', value: 'nope', ts: 1 });

  assert.equal((await adapter.get('room/msgs/a')).value, 'hi');
  assert.equal((await adapter.getAll('room/msgs/')).length, 2);
  assert.equal((await adapter.getAll('other/')).length, 1);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('FileSystemStorageAdapter: data survives a simulated restart (new instance, same file)', async () => {
  const dir = await tmpDir('store-restart');
  const filePath = path.join(dir, 'log.ndjson');

  const first = new FileSystemStorageAdapter(filePath);
  await first.put('~fp/alias', { id: '~fp/alias', value: 'alice', ts: 100 });

  const second = new FileSystemStorageAdapter(filePath); // simulates a fresh process reading the same log
  const row = await second.get('~fp/alias');
  assert.equal(row.value, 'alice');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('FileSystemStorageAdapter: a later write with a lower ts does not lose the newer one on reload', async () => {
  const dir = await tmpDir('store-lww');
  const filePath = path.join(dir, 'log.ndjson');
  const first = new FileSystemStorageAdapter(filePath);
  await first.put('x', { id: 'x', value: 'new', ts: 200 });
  await first.put('x', { id: 'x', value: 'old-appended-later-by-mistake', ts: 100 });

  const second = new FileSystemStorageAdapter(filePath);
  const row = await second.get('x');
  assert.equal(row.value, 'new', 'reload must keep the highest-ts value for a given id, not just the last line');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('FileSystemStorageAdapter: an exact-ts collision on reload resolves the same deterministic way QuStore.put() itself would (writer tiebreak, not "last line in the file wins")', async () => {
  const dir = await tmpDir('store-tiebreak');
  const filePath = path.join(dir, 'log.ndjson');
  const first = new FileSystemStorageAdapter(filePath);
  // Same id, same ts, different writer — written in an order where the
  // LOSING writer's line is deliberately LAST in the file, so a naive
  // "last line wins" reload would get this wrong.
  await first.put('x', { id: 'x', value: 'from bob', ts: 100, writer: 'bob' });
  await first.put('x', { id: 'x', value: 'from alice', ts: 100, writer: 'alice' });

  const second = new FileSystemStorageAdapter(filePath);
  const row = await second.get('x');
  assert.equal(row.writer, 'bob', '"bob" > "alice" lexicographically — same tiebreak as compareQubits()/QuStore.put(), regardless of line order in the log');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('FileSystemFileStorageAdapter: chunk round-trip and persistence across restart', async () => {
  const dir = await tmpDir('chunks');
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const hash = 'abc123ff';

  const first = new FileSystemFileStorageAdapter(dir);
  await first.putChunk(hash, bytes);
  assert.equal(await first.hasChunk(hash), true);

  const second = new FileSystemFileStorageAdapter(dir);
  const got = await second.getChunk(hash);
  assert.deepEqual(got, bytes);

  await second.deleteChunk(hash);
  assert.equal(await second.hasChunk(hash), false);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('FileSystemFileStorageAdapter: rejects a malformed hash instead of touching the filesystem with it', async () => {
  const dir = await tmpDir('chunks-guard');
  const adapter = new FileSystemFileStorageAdapter(dir);
  await assert.rejects(() => adapter.putChunk('../../etc/passwd', new Uint8Array([1])));
  await fsp.rm(dir, { recursive: true, force: true });
});
