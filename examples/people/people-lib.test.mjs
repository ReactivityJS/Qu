import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesQuery, sortDirectory, isValidFingerprint } from './people-lib.mjs';

test('isValidFingerprint()', () => {
  assert.equal(isValidFingerprint('a1b2c3d4e5f60718293a4b5c'), true);
  assert.equal(isValidFingerprint('A1B2C3D4E5F60718293A4B5C'), true);
  assert.equal(isValidFingerprint('too-short'), false);
  assert.equal(isValidFingerprint(''), false);
  assert.equal(isValidFingerprint(null), false);
  assert.equal(isValidFingerprint(undefined), false);
});

test('matchesQuery(): matches alias OR fingerprint, case-insensitively', () => {
  const entry = { alias: 'Alice', fingerprint: 'a1b2c3d4e5f60718293a4b5c' };
  assert.equal(matchesQuery(entry, 'ali'), true);
  assert.equal(matchesQuery(entry, 'ALICE'), true);
  assert.equal(matchesQuery(entry, 'a1b2'), true);
  assert.equal(matchesQuery(entry, 'A1B2'), true);
  assert.equal(matchesQuery(entry, 'bob'), false);
});

test('matchesQuery(): empty/whitespace query matches everything', () => {
  const entry = { alias: 'Alice', fingerprint: 'a1b2c3d4e5f60718293a4b5c' };
  assert.equal(matchesQuery(entry, ''), true);
  assert.equal(matchesQuery(entry, '   '), true);
  assert.equal(matchesQuery(entry, undefined), true);
});

test('matchesQuery(): an entry with no alias yet (still the fingerprint default) is still findable by fingerprint', () => {
  const entry = { alias: null, fingerprint: 'a1b2c3d4e5f60718293a4b5c' };
  assert.equal(matchesQuery(entry, 'a1b2'), true);
  assert.equal(matchesQuery(entry, 'anything-else'), false);
});

test('sortDirectory(): alphabetical by alias, stable by fingerprint on ties', () => {
  const entries = [
    { alias: 'Carol', fingerprint: 'c' },
    { alias: 'alice', fingerprint: 'a' },
    { alias: 'Bob', fingerprint: 'b1' },
    { alias: 'Bob', fingerprint: 'b0' },
  ];
  const sorted = sortDirectory(entries);
  assert.deepEqual(sorted.map((e) => e.fingerprint), ['a', 'b0', 'b1', 'c']);
});
