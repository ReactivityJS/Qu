import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../../src/index.js';
import {
  getOwnGreetingName, setOwnGreetingName, onOwnGreetingNameChange,
  recordVisit, getOwnVisitCount, onOwnVisitCountChange,
  getGlobalGreeting, setGlobalGreeting, onGlobalGreetingChange,
} from './hello-world-lib.mjs';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('getOwnGreetingName(): null when never set', async () => {
  const qu = await Qu.create();
  assert.equal(await getOwnGreetingName(qu), null);
});

test('setOwnGreetingName()/getOwnGreetingName(): round-trips a plain value', async () => {
  const qu = await Qu.create();
  await setOwnGreetingName(qu, 'Ada');
  assert.equal(await getOwnGreetingName(qu), 'Ada');
});

test('setOwnGreetingName(): is plain, not encrypted — a raw store read shows the value', async () => {
  const qu = await Qu.create();
  await setOwnGreetingName(qu, 'Ada');
  const raw = await qu.runtime.get(`${qu.own.id}/apps/hello-world/greeting-name`);
  assert.equal(raw.value, 'Ada');
});

test('onOwnGreetingNameChange(): a single call delivers the current value immediately, then future changes', async () => {
  const qu = await Qu.create();
  await setOwnGreetingName(qu, 'Ada');
  await wait();

  const seen = [];
  onOwnGreetingNameChange(qu, (q) => seen.push(q.value));
  await wait();
  assert.deepEqual(seen, ['Ada'], 'the already-set name must arrive without a separate one-shot read');

  await setOwnGreetingName(qu, 'Grace');
  await wait();
  assert.deepEqual(seen, ['Ada', 'Grace']);
});

test('getOwnVisitCount(): 0 when never visited', async () => {
  const qu = await Qu.create();
  assert.equal(await getOwnVisitCount(qu), 0);
});

test('recordVisit()/getOwnVisitCount(): each recorded visit increments the count, never regresses it', async () => {
  const qu = await Qu.create();
  await recordVisit(qu);
  await recordVisit(qu);
  await recordVisit(qu);
  assert.equal(await getOwnVisitCount(qu), 3);
});

test('recordVisit(): two different identities have independent counts', async () => {
  const alice = await Qu.create();
  const bob = await Qu.create({ runtime: alice.runtime });
  await recordVisit(alice);
  await recordVisit(alice);
  await recordVisit(bob);
  assert.equal(await getOwnVisitCount(alice), 2);
  assert.equal(await getOwnVisitCount(bob), 1);
});

test('onOwnVisitCountChange(): a single call delivers the current count immediately, then updates on every future visit', async () => {
  const qu = await Qu.create();
  await recordVisit(qu);
  await wait();

  const seen = [];
  onOwnVisitCountChange(qu, (count) => seen.push(count));
  await wait();
  assert.deepEqual(seen, [1], 'the already-recorded visit must be counted without a separate one-shot read');

  await recordVisit(qu);
  await wait();
  assert.deepEqual(seen, [1, 2]);
});

test('recordVisit(): never reads existing state first — a fresh, not-yet-synced local view (0 known visits) still only ADDS a visit instead of overwriting the true count', async () => {
  // Regression test for the bug an earlier read-then-increment design had:
  // right after a reload, the local Space is genuinely empty until the
  // relay re-syncs it — a naive `count = await get(); put(count + 1)`
  // would read 0 and overwrite an already-higher relay-held count with 1.
  const qu = await Qu.create();
  await recordVisit(qu);
  await recordVisit(qu);
  assert.equal(await getOwnVisitCount(qu), 2);

  // Simulate "reload with an empty local view but the relay/store already
  // has 2 visits" — a second identity handle sharing the SAME underlying
  // runtime (so the data really is there) still only counts, never writes
  // based on a guessed prior value.
  const sameIdentity = await Qu.create({ identity: qu.identity, runtime: qu.runtime });
  await recordVisit(sameIdentity);
  assert.equal(await getOwnVisitCount(sameIdentity), 3);
  assert.equal(await getOwnVisitCount(qu), 3);
});

test('getGlobalGreeting(): null when no admin has ever configured one', async () => {
  const qu = await Qu.create();
  assert.equal(await getGlobalGreeting(qu), null);
});

test('setGlobalGreeting()/getGlobalGreeting(): round-trips, visible to a DIFFERENT identity on the same runtime', async () => {
  const admin = (await Qu.create()).use(createSpacesPlugin());
  const visitor = (await Qu.create({ runtime: admin.runtime })).use(createSpacesPlugin());

  await setGlobalGreeting(admin, 'Willkommen!');
  assert.equal(await getGlobalGreeting(visitor), 'Willkommen!');
});

test('onGlobalGreetingChange(): a single call delivers the current value immediately, then future changes', async () => {
  const admin = (await Qu.create()).use(createSpacesPlugin());
  await setGlobalGreeting(admin, 'Willkommen!');
  await wait();

  const seen = [];
  onGlobalGreetingChange(admin, (q) => seen.push(q.value));
  await wait();
  assert.deepEqual(seen, ['Willkommen!']);

  await setGlobalGreeting(admin, 'Hallo zusammen!');
  await wait();
  assert.deepEqual(seen, ['Willkommen!', 'Hallo zusammen!']);
});
