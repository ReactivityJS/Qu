import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPersistedMap } from './persisted-map.mjs';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qu-persisted-map-')), 'subs.json');
}

test('set()/get()/has()/delete() behave like a Map', () => {
  const map = createPersistedMap(tmpFile());
  assert.equal(map.has('a'), false);
  map.set('a', { endpoint: 'https://x' });
  assert.equal(map.has('a'), true);
  assert.deepEqual(map.get('a'), { endpoint: 'https://x' });
  assert.equal(map.size, 1);
  assert.equal(map.delete('a'), true);
  assert.equal(map.has('a'), false);
  assert.equal(map.delete('missing'), false);
});

test('survives being recreated against the same file (actual persistence)', () => {
  const file = tmpFile();
  const map1 = createPersistedMap(file);
  map1.set('fp1', { endpoint: 'https://a' });
  map1.set('fp2', { endpoint: 'https://b' });

  const map2 = createPersistedMap(file);
  assert.deepEqual(map2.get('fp1'), { endpoint: 'https://a' });
  assert.deepEqual(map2.get('fp2'), { endpoint: 'https://b' });
  assert.equal(map2.size, 2);

  map2.delete('fp1');
  const map3 = createPersistedMap(file);
  assert.equal(map3.has('fp1'), false);
  assert.equal(map3.has('fp2'), true);
});

test('a missing or corrupt file starts empty instead of throwing', () => {
  const missing = createPersistedMap(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qu-persisted-map-')), 'does-not-exist.json'));
  assert.equal(missing.size, 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qu-persisted-map-'));
  const corruptFile = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptFile, 'not json{{{');
  const corrupt = createPersistedMap(corruptFile);
  assert.equal(corrupt.size, 0);
  corrupt.set('ok', 1); // still writable afterward
  assert.equal(corrupt.get('ok'), 1);
});

test('creates its parent directory on first write if missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qu-persisted-map-'));
  const nested = path.join(dir, 'nested', 'subs.json');
  const map = createPersistedMap(nested);
  map.set('fp', { endpoint: 'https://x' });
  assert.equal(fs.existsSync(nested), true);
});
