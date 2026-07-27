import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionGate } from '../src/index.js';

test('createConnectionGate: with no limits configured, anything is allowed', () => {
  const gate = createConnectionGate();
  assert.deepEqual(gate.check({ fingerprint: 'abc', connectedCount: 999 }), { allowed: true });
  assert.deepEqual(gate.check({ fingerprint: null, connectedCount: 0 }), { allowed: true });
});

test('createConnectionGate: an anonymous connection (no fingerprint) is never rejected, regardless of limits', () => {
  const gate = createConnectionGate({ maxConnections: 0, allowedFingerprints: ['only-this-one'] });
  assert.deepEqual(gate.check({ fingerprint: null, connectedCount: 100 }), { allowed: true });
});

test('createConnectionGate: maxConnections rejects once the count already reaches the ceiling', () => {
  const gate = createConnectionGate({ maxConnections: 2 });
  assert.equal(gate.check({ fingerprint: 'a', connectedCount: 0 }).allowed, true);
  assert.equal(gate.check({ fingerprint: 'a', connectedCount: 1 }).allowed, true);
  const rejected = gate.check({ fingerprint: 'a', connectedCount: 2 });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reason, 'max-connections');
});

test('createConnectionGate: allowedFingerprints rejects any fingerprint not on the list, independent of maxConnections', () => {
  const gate = createConnectionGate({ allowedFingerprints: ['alice-fp'] });
  assert.equal(gate.check({ fingerprint: 'alice-fp', connectedCount: 0 }).allowed, true);
  const rejected = gate.check({ fingerprint: 'mallory-fp', connectedCount: 0 });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reason, 'not-allow-listed');
});

test('createConnectionGate: configure() live-changes both limits, undefined fields left untouched, explicit null clears a limit', () => {
  const gate = createConnectionGate({ maxConnections: 1, allowedFingerprints: ['alice-fp'] });
  assert.equal(gate.check({ fingerprint: 'bob-fp', connectedCount: 0 }).allowed, false);

  gate.configure({ allowedFingerprints: null }); // clear the allowlist, leave maxConnections alone
  assert.deepEqual(gate.getConfig(), { maxConnections: 1, allowedFingerprints: null });
  assert.equal(gate.check({ fingerprint: 'bob-fp', connectedCount: 0 }).allowed, true, 'no longer allow-list-restricted');
  assert.equal(gate.check({ fingerprint: 'bob-fp', connectedCount: 1 }).allowed, false, 'maxConnections still enforced');

  gate.configure({ maxConnections: 5 });
  assert.deepEqual(gate.getConfig(), { maxConnections: 5, allowedFingerprints: null });
});
