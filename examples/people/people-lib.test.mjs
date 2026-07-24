import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidFingerprint } from './people-lib.mjs';

test('isValidFingerprint() (re-exported from core/identity.js)', () => {
  assert.equal(isValidFingerprint('a1b2c3d4e5f60718293a4b5c'), true);
  assert.equal(isValidFingerprint('A1B2C3D4E5F60718293A4B5C'), true);
  assert.equal(isValidFingerprint('too-short'), false);
  assert.equal(isValidFingerprint(''), false);
  assert.equal(isValidFingerprint(null), false);
  assert.equal(isValidFingerprint(undefined), false);
});
