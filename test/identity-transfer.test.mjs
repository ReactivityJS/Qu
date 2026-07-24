import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu } from '../src/qu.js';
import { exportIdentity, importIdentity } from '../src/modules/identity-transfer.js';

test('exportIdentity/importIdentity: unencrypted round-trip reconstructs the same fingerprint', async () => {
  const alice = await Qu.create();
  const exported = await exportIdentity(alice);
  assert.match(exported, /^qu-identity-v1:/);

  const keys = await importIdentity(exported);
  const alice2 = await Qu.create({ identity: keys, runtime: alice.runtime });
  assert.equal(alice2.fingerprint, alice.fingerprint);
});

test('exportIdentity/importIdentity: password-protected round-trip reconstructs the same fingerprint', async () => {
  const alice = await Qu.create();
  const exported = await exportIdentity(alice, { password: 'correct horse battery staple' });

  const keys = await importIdentity(exported, { password: 'correct horse battery staple' });
  const alice2 = await Qu.create({ identity: keys, runtime: alice.runtime });
  assert.equal(alice2.fingerprint, alice.fingerprint);
});

test('importIdentity: wrong password is rejected', async () => {
  const alice = await Qu.create();
  const exported = await exportIdentity(alice, { password: 'right-password' });
  await assert.rejects(() => importIdentity(exported, { password: 'wrong-password' }));
});

test('importIdentity: encrypted export without a password is rejected', async () => {
  const alice = await Qu.create();
  const exported = await exportIdentity(alice, { password: 'right-password' });
  await assert.rejects(() => importIdentity(exported));
});

test('importIdentity: tampered ciphertext is rejected', async () => {
  const alice = await Qu.create();
  const exported = await exportIdentity(alice, { password: 'right-password' });
  const tampered = exported.slice(0, -4) + (exported.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  await assert.rejects(() => importIdentity(tampered, { password: 'right-password' }));
});

test('importIdentity: unrecognized string is rejected', async () => {
  await assert.rejects(() => importIdentity('not-a-real-export'));
  await assert.rejects(() => importIdentity(''));
});

test('exportIdentity: two exports of the same identity+password never produce identical strings', async () => {
  const alice = await Qu.create();
  const exportedA = await exportIdentity(alice, { password: 'same-password' });
  const exportedB = await exportIdentity(alice, { password: 'same-password' });
  assert.notEqual(exportedA, exportedB);

  const keysA = await importIdentity(exportedA, { password: 'same-password' });
  const keysB = await importIdentity(exportedB, { password: 'same-password' });
  const aliceA = await Qu.create({ identity: keysA, runtime: alice.runtime });
  const aliceB = await Qu.create({ identity: keysB, runtime: alice.runtime });
  assert.equal(aliceA.fingerprint, alice.fingerprint);
  assert.equal(aliceB.fingerprint, alice.fingerprint);
});
