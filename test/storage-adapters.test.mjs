import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, NullAdapter } from '../src/index.js';
import { assertStorageAdapterContract } from './helpers.mjs';

test('MemoryAdapter satisfies the StorageAdapter contract', async () => {
  await assertStorageAdapterContract(new MemoryAdapter());
});

test('MemoryAdapter.clear() empties the adapter', async () => {
  const adapter = new MemoryAdapter();
  await adapter.put('a', { id: 'a', value: 1, ts: 1 });
  await adapter.clear();
  assert.equal(await adapter.get('a'), null);
  assert.deepEqual(await adapter.getAll(''), []);
});

test('NullAdapter: a real Runtime accepts writes through it (ingest never sees a rejection) but retains nothing', async () => {
  // NullAdapter's own contract is the opposite of the shared one above —
  // it must never round-trip anything (see adapters/null.js) — so it gets
  // its own, narrower assertions instead of assertStorageAdapterContract().
  const adapter = new NullAdapter();
  await adapter.put('x', { id: 'x', value: 'ephemeral', ts: 1 });
  assert.equal(await adapter.get('x'), null, 'NullAdapter must never retain a value, even right after put()');
  assert.deepEqual(await adapter.getAll('x'), [], 'getAll() must always be empty');
  await adapter.delete('x'); // must not throw on an id it never had
});
