import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, createDevicesPlugin, registerDevice, removeDevice, listDevices, onDevicesChange } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('registerDevice(): rejects a missing/empty deviceId', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await assert.rejects(() => registerDevice(owner, ''));
  await assert.rejects(() => registerDevice(owner, undefined));
});

test('registerDevice()/listDevices(): registers a device and lists it back with label/firstSeen/lastSeen', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await registerDevice(owner, 'device-pc-1', { label: 'Mein PC' });

  const devices = await listDevices(owner);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deviceId, 'device-pc-1');
  assert.equal(devices[0].label, 'Mein PC');
  assert.ok(devices[0].firstSeen > 0);
  assert.equal(devices[0].firstSeen, devices[0].lastSeen, 'on first registration, firstSeen and lastSeen coincide');
});

test('registerDevice(): a repeat call for the same deviceId preserves firstSeen but bumps lastSeen', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await registerDevice(owner, 'device-phone-1', { label: 'Handy' });
  const [first] = await listDevices(owner);

  await wait(5);
  await registerDevice(owner, 'device-phone-1', { label: 'Handy (umbenannt)' });
  const [second] = await listDevices(owner);

  assert.equal(second.firstSeen, first.firstSeen, 'firstSeen must never change on re-registration');
  assert.ok(second.lastSeen > first.lastSeen, 'lastSeen must advance on re-registration');
  assert.equal(second.label, 'Handy (umbenannt)');
});

test('registerDevice(): is encrypted-to-self — a raw store read never shows the plaintext device info', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await registerDevice(owner, 'device-secret', { label: 'Geheimgerät' });

  const raw = await owner.runtime.get(`${owner.own.id}/devices/device-secret`);
  assert.ok(raw);
  assert.notEqual(raw.value?.label, 'Geheimgerät');
});

test('removeDevice(): tombstones a device — listDevices()/onDevicesChange() both treat it as absent', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const seen = [];
  onDevicesChange(owner, (q) => seen.push(q.value));

  await registerDevice(owner, 'device-to-remove', { label: 'Wird entfernt' });
  await wait();
  assert.equal((await listDevices(owner)).length, 1);

  await removeDevice(owner, 'device-to-remove');
  await wait();

  assert.equal((await listDevices(owner)).length, 0);
  assert.deepEqual(seen.at(-1), null, 'the live subscription must see the tombstone (null) as its own event');
});

test('removeDevice(): removing an unknown deviceId is a harmless no-op', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await removeDevice(owner, 'never-registered'); // must not throw
  assert.equal((await listDevices(owner)).length, 0);
});

test('listDevices(): only the owner\'s own devices are ever returned, never someone else\'s', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const other = (await Qu.create({ runtime: owner.runtime })).use(createSpacesPlugin());

  await registerDevice(owner, 'owner-device');
  await registerDevice(other, 'other-device');

  const ownerDevices = await listDevices(owner);
  assert.equal(ownerDevices.length, 1);
  assert.equal(ownerDevices[0].deviceId, 'owner-device');
});

test('qu.registerDevice()/qu.removeDevice()/etc.: the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createDevicesPlugin());
  await owner.registerDevice('device-x', { label: 'X' });

  const devices = await owner.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].label, 'X');

  await owner.removeDevice('device-x');
  assert.equal((await owner.listDevices()).length, 0);
});
