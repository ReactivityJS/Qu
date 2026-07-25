// LocalStorageAdapter/SessionStorageAdapter/IndexedDBAdapter need real
// browser globals (localStorage/sessionStorage/indexedDB) that plain Node
// does not provide (verified: Node 22 has none of them). This file has no
// `node:*` imports besides node:test/node:assert, so server/test-runner.mjs
// classifies it as browser-safe and test/index.html actually exercises it
// for real. Under `npm test` (plain Node), each test trivially passes
// instead of asserting anything real — deliberately, not silently: the sole
// place these three adapters get genuinely verified is the browser
// dashboard (see README's "Tests"/"Status" sections).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageAdapter, SessionStorageAdapter, IndexedDBAdapter } from '../src/index.js';
import { assertStorageAdapterContract } from './helpers.mjs';

const hasBrowserStorage = typeof localStorage !== 'undefined' && typeof sessionStorage !== 'undefined' && typeof indexedDB !== 'undefined';

function browserOnlyTest(name, run) {
  test(name, async () => {
    if (!hasBrowserStorage) {
      assert.ok(true, 'skipped: no browser storage globals in this environment — run test/index.html for the real check');
      return;
    }
    await run();
  });
}

browserOnlyTest('LocalStorageAdapter satisfies the StorageAdapter contract', async () => {
  const adapter = new LocalStorageAdapter({ namespace: `qu-contract-test-${Date.now()}:` });
  await assertStorageAdapterContract(adapter);
  await adapter.clear();
});

browserOnlyTest('SessionStorageAdapter satisfies the StorageAdapter contract', async () => {
  const adapter = new SessionStorageAdapter({ namespace: `qu-contract-test-${Date.now()}:` });
  await assertStorageAdapterContract(adapter);
  await adapter.clear();
});

browserOnlyTest('IndexedDBAdapter satisfies the StorageAdapter contract', async () => {
  const adapter = new IndexedDBAdapter({ dbName: `qu-contract-test-${Date.now()}` });
  await assertStorageAdapterContract(adapter);
  await adapter.clear();
});

browserOnlyTest('LocalStorageAdapter: two instances with different namespaces on the same origin never see each other\'s data', async () => {
  const ns = Date.now();
  const a = new LocalStorageAdapter({ namespace: `qu-ns-a-${ns}:` });
  const b = new LocalStorageAdapter({ namespace: `qu-ns-b-${ns}:` });
  await a.put('x', { id: 'x', value: 'from a', ts: 1 });
  assert.equal(await b.get('x'), null, 'a differently-namespaced adapter must not see the first one\'s write');
  assert.deepEqual(await b.getAll(''), []);
  await a.clear();
});

browserOnlyTest('LocalStorageAdapter: a pre-existing non-JSON value (e.g. from before this adapter existed, or a key collision on an empty namespace) is treated as absent, not a thrown exception', async () => {
  const ns = `qu-corrupt-test-${Date.now()}:`;
  const adapter = new LocalStorageAdapter({ namespace: ns });
  localStorage.setItem(`${ns}bad`, 'Chrome/121.0.0.0'); // a raw, non-JSON string — exactly what an unrelated script/extension or a pre-migration write could leave behind
  localStorage.setItem(`${ns}good`, JSON.stringify({ id: 'good', value: 1, ts: 1 }));
  assert.equal(await adapter.get('bad'), null, 'a corrupt entry must resolve to null, never throw');
  const all = await adapter.getAll('');
  assert.deepEqual(all, [{ id: 'good', value: 1, ts: 1 }], 'getAll() must skip the corrupt entry but keep the valid one');
  await adapter.clear();
});
