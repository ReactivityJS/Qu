import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../index.js';
import { getShowDisabledServices, setShowDisabledServices, onShowDisabledServicesChange } from './service-visibility.mjs';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('getShowDisabledServices(): false when never configured', async () => {
  const qu = await Qu.create();
  assert.equal(await getShowDisabledServices(qu), false);
});

test('setShowDisabledServices()/getShowDisabledServices(): round-trips', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  await setShowDisabledServices(qu, true);
  assert.equal(await getShowDisabledServices(qu), true);
});

test('setShowDisabledServices(): is plain, not encrypted — a raw store read shows the value', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  await setShowDisabledServices(qu, true);
  const raw = await qu.runtime.get('relay-config/show-disabled-apps');
  assert.equal(raw.value, true);
});

test('setShowDisabledServices(): visible to a DIFFERENT identity on the same runtime (public, not per-user)', async () => {
  const admin = (await Qu.create()).use(createSpacesPlugin());
  const visitor = (await Qu.create({ runtime: admin.runtime })).use(createSpacesPlugin());
  await setShowDisabledServices(admin, true);
  assert.equal(await getShowDisabledServices(visitor), true);
});

test('onShowDisabledServicesChange(): a single call delivers the current value immediately, then future changes', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  await setShowDisabledServices(qu, true);
  await wait();

  const seen = [];
  onShowDisabledServicesChange(qu, (q) => seen.push(q.value));
  await wait();
  assert.deepEqual(seen, [true]);

  await setShowDisabledServices(qu, false);
  await wait();
  assert.deepEqual(seen, [true, false]);
});
