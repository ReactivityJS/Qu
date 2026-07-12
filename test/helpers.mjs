import assert from 'node:assert/strict';
import { QuRuntime, QuStore, MemoryAdapter, createVerifyPlugin } from '../src/index.js';

export function makeRuntime() {
  const rt = new QuRuntime({ store: new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]) });
  rt.use(createVerifyPlugin());
  return rt;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(o + 65536, n)));
  return out;
}

/**
 * A handful of tests deliberately trigger an error path (a forged qubit, a
 * throwing subscriber) specifically to prove it's handled gracefully — the
 * resulting console.error is the test passing, not failing. Without this,
 * that expected noise is indistinguishable from a real problem when
 * watching the console (CLI or browser) during a normal run. Captures the
 * calls (so the test can still assert on them) without ever printing them.
 */
/**
 * The shared assertions every StorageAdapter (`core/storage.js`) must
 * satisfy, run once per concrete adapter instead of duplicated per test
 * file — used by both test/storage-adapters.test.mjs (Memory/Null, work
 * identically in Node and the browser) and
 * test/storage-adapters-browser.test.mjs (LocalStorage/SessionStorage/
 * IndexedDB, real-browser-only). Deliberately covers only the four methods
 * `assertStorageAdapter()` actually requires (get/put/delete/getAll) — not
 * `clear()` (present on most adapters as a convenience, not part of the
 * Core contract) and not FileSystemStorageAdapter's own extra
 * out-of-order-log-reconciliation guarantee (test/adapters-filesystem.test.mjs),
 * which is specific to its append-only-log format, not something every
 * adapter needs to promise.
 */
export async function assertStorageAdapterContract(adapter) {
  const a = { id: 'contract/a', value: 'first', ts: 1 };
  const b = { id: 'contract/b', value: 'second', ts: 2 };
  const other = { id: 'elsewhere/c', value: 'third', ts: 3 };

  assert.equal(await adapter.get('contract/never-written'), null, 'get() on an unknown id must return null, not throw or return undefined');

  await adapter.put(a.id, a);
  await adapter.put(b.id, b);
  await adapter.put(other.id, other);

  assert.deepEqual(await adapter.get(a.id), a, 'get() must return exactly what was put()');

  const prefixed = await adapter.getAll('contract/');
  assert.equal(prefixed.length, 2, 'getAll(prefix) must return every entry under that prefix...');
  assert.ok(prefixed.every((q) => q.id.startsWith('contract/')), '...and nothing outside it');

  await adapter.delete(a.id);
  assert.equal(await adapter.get(a.id), null, 'delete() must make a subsequent get() return null');
  assert.equal((await adapter.getAll('contract/')).length, 1, 'delete() must also remove the entry from getAll()');
}

export async function withSilencedConsoleError(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => { calls.push(args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}
