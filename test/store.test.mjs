import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuStore, MemoryAdapter } from '../src/index.js';
import { compareQubits } from '../src/core/store.js';

test('compareQubits(): ts decides first, writer is a deterministic tiebreaker on an exact tie', async () => {
  const a = { id: 'x', ts: 10, writer: 'alice', value: 1 };
  const b = { id: 'x', ts: 20, writer: 'bob', value: 2 };
  assert.ok(compareQubits(a, b) < 0, 'lower ts loses regardless of writer');
  assert.ok(compareQubits(b, a) > 0);

  const tieAlice = { id: 'x', ts: 15, writer: 'alice', value: 1 };
  const tieBob = { id: 'x', ts: 15, writer: 'bob', value: 2 };
  assert.ok(compareQubits(tieAlice, tieBob) < 0, '"alice" < "bob" lexicographically — alice loses the tie');
  assert.ok(compareQubits(tieBob, tieAlice) > 0);
  assert.equal(compareQubits(tieAlice, { ...tieAlice }), 0, 'identical id/ts/writer is a true duplicate — neither wins');
});

test('compareQubits() is symmetric and consistent regardless of which qubit is "incoming" vs "existing"', async () => {
  const p = { id: 'x', ts: 5, writer: 'zzz' };
  const q = { id: 'x', ts: 5, writer: 'aaa' };
  const first = compareQubits(p, q);
  const second = compareQubits(q, p);
  assert.ok(Math.sign(first) === -Math.sign(second), 'the comparison must reverse consistently, not just "whoever asks first wins"');
});

test('QuStore.put(): on an exact ts tie, the SAME qubit wins no matter which one arrives at this store first', async () => {
  const alice = { id: 'shared', ts: 100, writer: 'alice', value: 'from alice' };
  const bob = { id: 'shared', ts: 100, writer: 'bob', value: 'from bob' };

  const storeA = new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
  await storeA.put(alice);
  await storeA.put(bob); // bob arrives second here...

  const storeB = new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
  await storeB.put(bob);
  await storeB.put(alice); // ...but alice arrives second here — the two stores must still converge

  const winnerA = await storeA.get('shared');
  const winnerB = await storeB.get('shared');
  assert.deepEqual(winnerA, winnerB, 'two replicas that saw the same colliding writes in opposite order must converge on the same winner');
  assert.equal(winnerA.writer, 'bob', '"bob" > "alice" lexicographically — bob wins the tie deterministically');
});

test('QuStore.put(): a qubit with a strictly higher ts always wins, even against a "later" writer', async () => {
  const store = new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
  await store.put({ id: 'x', ts: 5, writer: 'zzz', value: 'older but lexicographically later writer' });
  const result = await store.put({ id: 'x', ts: 10, writer: 'aaa', value: 'newer' });
  assert.equal(result.accepted, true);
  assert.equal((await store.get('x')).value, 'newer', 'ts always dominates — writer only matters on an exact tie');
});
