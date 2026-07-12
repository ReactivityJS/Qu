import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuClock } from '../src/core/clock.js';

test('next() never returns the same value twice, even for many calls inside one millisecond', async () => {
  const clock = new QuClock();
  const seen = new Set();
  let prev = -Infinity;
  // 999 is QuClock's own per-millisecond cap — calling it more than that in
  // a tight loop is exactly the scenario that exposed the bug (two writes,
  // e.g. examples/todo-lib.mjs's createSpace() + grantWriteAccess(), landing
  // in the same millisecond).
  for (let i = 0; i < 999; i++) {
    const ts = clock.next();
    assert.ok(ts > prev, `next() must be strictly increasing — got ${ts} after ${prev} at call ${i}`);
    assert.ok(!seen.has(ts), `next() must never repeat a value — ${ts} was already returned (call ${i})`);
    seen.add(ts);
    prev = ts;
  }
});

test('regression: two different writes to the same id within one millisecond must not collide (previously silently dropped the second write)', async () => {
  // Direct reproduction of the historical bug, without needing to actually
  // land two writes inside the same real millisecond (unreliable to force
  // from outside) — QuClock is the only thing that decides whether two
  // back-to-back next() calls can produce an equal ts, so testing it in
  // isolation is both sufficient and deterministic.
  const clock = new QuClock();
  const a = clock.next();
  const b = clock.next();
  assert.notEqual(a, b, 'two consecutive next() calls (the common case: two writes on the same Runtime, back to back) must never collide');
});

test('the fractional sequence survives IEEE-754 double precision at realistic wall-clock magnitudes (today and ~80 years out)', async () => {
  const magnitudes = [
    Date.now(),        // today
    4102444800000,     // 2100-01-01T00:00:00Z
  ];
  for (const wall of magnitudes) {
    const seen = new Set();
    for (let seq = 0; seq <= 999; seq++) {
      const ts = wall + seq / 1000;
      seen.add(ts);
    }
    assert.equal(seen.size, 1000, `all 1000 sequence values must remain distinguishable at wall-clock magnitude ${wall}`);
  }
});

test('receive(remoteTs) fast-forwards the wall part to a newer remote timestamp and resets the sequence', async () => {
  const clock = new QuClock();
  const future = Date.now() + 60_000;
  clock.receive(future + 0.5); // a remote HLC value, fractional part included
  const next = clock.next();
  assert.ok(next >= future, 'next() after receive() must not fall behind the observed remote wall time');
  assert.ok(next < future + 1, 'the sequence must have reset, not carried over a large fractional offset');
});
