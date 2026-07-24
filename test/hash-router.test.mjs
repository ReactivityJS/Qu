import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, parsePathSegments } from '../src/index.js';

test('buildPath()/parsePathSegments(): single-segment round-trip', () => {
  const hash = buildPath('profile');
  assert.equal(hash, '#/profile');
  assert.deepEqual(parsePathSegments(hash), ['profile']);
});

test('buildPath()/parsePathSegments(): multi-segment round-trip', () => {
  const hash = buildPath('dm-abc123', 'settings');
  assert.equal(hash, '#/dm-abc123/settings');
  assert.deepEqual(parsePathSegments(hash), ['dm-abc123', 'settings']);
});

test('buildPath(): encodes special characters per segment', () => {
  const hash = buildPath('add-contact', 'a b/c');
  assert.deepEqual(parsePathSegments(hash), ['add-contact', 'a b/c']);
});

test('parsePathSegments(): root/empty/non-path hash all yield []', () => {
  assert.deepEqual(parsePathSegments(''), []);
  assert.deepEqual(parsePathSegments('#/'), []);
  assert.deepEqual(parsePathSegments('#room=xyz'), []);
  assert.deepEqual(parsePathSegments(undefined), []);
});
