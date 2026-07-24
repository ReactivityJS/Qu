import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, isValidFingerprint } from '../src/index.js';
import { canonical } from '../src/core/sign.js';
import { makeRuntime } from './helpers.mjs';

test('isValidFingerprint(): a real generated fingerprint always passes, garbage never does', async () => {
  const alice = await QuIdentity.generate();
  assert.equal(isValidFingerprint(alice.fingerprint), true);
  assert.equal(isValidFingerprint(alice.fingerprint.toUpperCase()), true);
  assert.equal(isValidFingerprint('too-short'), false);
  assert.equal(isValidFingerprint(''), false);
  assert.equal(isValidFingerprint(null), false);
  assert.equal(isValidFingerprint(undefined), false);
});

test('a forged writer claim is rejected — fingerprint must equal hash(embedded pubKey)', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();

  const forged = { id: 'chat/room1/fake', value: 'hello', ts: Date.now() };
  forged.sig = await mallory.sign(canonical(forged));       // Mallory's real signature...
  forged.writer = alice.fingerprint;                        // ...claiming to be Alice
  forged.pubKey = await mallory.exportPublicSigningKey();   // ...embedding Mallory's own key

  await assert.rejects(() => rt.ingest(forged));
});

test('tampering with a value after signing fails the signature check', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  const { qubit: legit } = await session.publish('chat/room1/legit', 'original');
  await assert.rejects(() => rt.ingest({ ...legit, value: 'tampered' }));
});

test('tampering with refs after signing is rejected too (refs are part of the signed payload)', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  const { qubit } = await session.publish(
    'chat/room1/msg-with-attachment',
    { text: 'see attached' },
    { refs: ['files/abc123'] },
  );
  await assert.rejects(() => rt.ingest({ ...qubit, refs: ['files/malicious-swap'] }));

  const stored = await session.get('chat/room1/msg-with-attachment');
  assert.deepEqual(stored.refs, ['files/abc123']);
});
