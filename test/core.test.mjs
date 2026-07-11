import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuRuntime, QuStore, MemoryAdapter, NullAdapter } from '../src/index.js';
import { QuSession, QuIdentity } from '../src/index.js';
import { makeRuntime, withSilencedConsoleError } from './helpers.mjs';

test('subscription trie routes only the matching branch, not a linear scan of all subscriptions', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  let hits = 0;
  rt.on('chat/room1/**', () => hits++);
  rt.on('chat/room2/**', () => { throw new Error('should not fire — wrong branch'); });

  await session.publish('chat/room1/msg1', { text: 'hi' });
  await session.publish('chat/room1/msg2', { text: 'again' });

  assert.equal(hits, 2);
});

test('a Mount backed by NullAdapter behaves as a pure event bus: dispatches live, persists nothing', async () => {
  const rt = new QuRuntime({
    store: new QuStore([
      { prefix: '', adapter: new MemoryAdapter() },
      { prefix: 'presence/', adapter: new NullAdapter() },
    ]),
  });

  let hits = 0;
  rt.on('presence/**', () => hits++);
  await rt.publish('presence/alice', { online: true });

  assert.equal(hits, 1, 'still dispatches to on()');
  assert.equal(await rt.get('presence/alice'), null, 'but persists nothing');
});

test('an async subscriber that rejects does not stop other subscribers or break subsequent dispatch', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  const seenByGood = [];
  rt.on('room/**', async () => { throw new Error('bad async subscriber'); });
  rt.on('room/**', (q) => { seenByGood.push(q.id); });

  const errorCalls = await withSilencedConsoleError(async () => {
    await session.publish('room/1', 'a');
    await new Promise((r) => setTimeout(r, 20)); // let the async rejection resolve/settle
    await session.publish('room/2', 'b');
    await new Promise((r) => setTimeout(r, 20));
  });

  assert.deepEqual(seenByGood, ['room/1', 'room/2']);
  assert.equal(errorCalls.length, 2, 'both rejections should have been logged (captured here, not printed)');
});

test('on() with no options is byte-identical to before: forward-only, nothing already in the store is delivered', async () => {
  const rt = makeRuntime();
  await rt.publish('room/old', 'before subscribing', { ts: 1 });

  const seen = [];
  rt.on('room/**', (q) => seen.push(q.value));
  await rt.publish('room/new', 'after subscribing', { ts: 2 });
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(seen, ['after subscribing']);
});

test('on({ initial: true }): delivers everything that already exists (sorted by ts), then continues delivering only new/changed qubits', async () => {
  const rt = makeRuntime();
  await rt.publish('room/a', 'second', { ts: 20 });
  await rt.publish('room/b', 'first', { ts: 10 });

  const seen = [];
  rt.on('room/**', (q) => seen.push(q.value), { initial: true });
  await new Promise((r) => setTimeout(r, 10)); // let the internal async catch-up run

  assert.deepEqual(seen, ['first', 'second'], 'existing items delivered in ts order');

  await rt.publish('room/c', 'third', { ts: 30 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['first', 'second', 'third']);
});

test('on({ once: true }): delivers only what already exists, then nothing further — no ongoing subscription', async () => {
  const rt = makeRuntime();
  await rt.publish('room/a', 'existing', { ts: 1 });

  const seen = [];
  const off = rt.on('room/**', (q) => seen.push(q.value), { once: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['existing']);

  await rt.publish('room/b', 'added after once() resolved', { ts: 2 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['existing'], 'once() must not deliver anything published afterward');

  assert.doesNotThrow(() => off(), 'the returned unsubscribe must be safely callable even though there was nothing to unsubscribe from');
});

test('on({ initial: true }): a qubit published DURING the async catch-up is delivered exactly once, not zero or two times', async () => {
  const rt = makeRuntime();
  await rt.publish('room/a', 'pre-existing', { ts: 1 });

  const seen = [];
  rt.on('room/**', (q) => seen.push(q.value), { initial: true });
  // No await here on purpose — publish immediately, racing the internal
  // query() that on({initial:true}) just kicked off.
  await rt.publish('room/b', 'published during the race window', { ts: 2 });
  await new Promise((r) => setTimeout(r, 20));

  const counts = seen.reduce((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
  assert.equal(counts['pre-existing'], 1);
  assert.equal(counts['published during the race window'], 1, 'must not be delivered twice (once via the snapshot, once via the live subscription) nor zero times');
});

test('on({ initial: true }): calling the returned unsubscribe before the async catch-up finishes prevents any delivery', async () => {
  const rt = makeRuntime();
  await rt.publish('room/a', 'existing', { ts: 1 });

  const seen = [];
  const off = rt.on('room/**', (q) => seen.push(q.value), { initial: true });
  off(); // synchronously, before the internal query() has had a chance to resolve
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(seen, [], 'cancelling before the catch-up resolves must suppress it entirely, not just the ongoing subscription');
});
