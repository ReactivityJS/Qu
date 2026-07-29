import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDecision, recordVisit } from './history-nav.mjs';

test('describeDecision(): home', () => {
  const entry = describeDecision({ kind: 'home', segments: [] });
  assert.deepEqual(entry, { hash: '#/', kind: 'home', label: 'Start', icon: '🏠' });
});

test('describeDecision(): space-default for a ~fp identity space', () => {
  const entry = describeDecision({ kind: 'space-default', spaceId: '~abc123', segments: ['~abc123'] });
  assert.deepEqual(entry, { hash: '#/~abc123', kind: 'identity', label: null, fingerprint: 'abc123', icon: '👤' });
});

test('describeDecision(): space-default for a generic Space UUID', () => {
  const entry = describeDecision({ kind: 'space-default', spaceId: 'board-42', segments: ['board-42'] });
  assert.deepEqual(entry, { hash: '#/board-42', kind: 'space', label: 'board-42', icon: '📦' });
});

test('describeDecision(): app/space resolves label+icon from the catalog', () => {
  const services = [{ id: 'hello-world', label: 'Hello World', icon: '👋' }];
  const entry = describeDecision({ kind: 'app', appId: 'hello-world', segments: ['hello-world'] }, services);
  assert.deepEqual(entry, { hash: '#/hello-world', kind: 'app', label: 'Hello World', icon: '👋' });
});

test('describeDecision(): app/space falls back to the raw appId when not (or no longer) in the catalog', () => {
  const entry = describeDecision({ kind: 'space', appId: 'gone', spaceId: '~fp', segments: ['~fp', 'gone'] }, []);
  assert.deepEqual(entry, { hash: '#/~fp/gone', kind: 'app', label: 'gone', icon: '📦' });
});

test('describeDecision(): unknown', () => {
  const entry = describeDecision({ kind: 'unknown', appId: 'ghost', spaceId: '~fp', segments: ['~fp', 'ghost'] });
  assert.deepEqual(entry, { hash: '#/~fp/ghost', kind: 'unknown', label: 'Unbekannt: ghost', icon: '❓' });
});

test('describeDecision(): pending is not a real page — returns null', () => {
  assert.equal(describeDecision({ kind: 'pending', segments: ['chat'] }), null);
});

test('recordVisit(): appends, most-recent-last', () => {
  let list = [];
  list = recordVisit(list, { hash: '#/a' });
  list = recordVisit(list, { hash: '#/b' });
  assert.deepEqual(list.map((e) => e.hash), ['#/a', '#/b']);
});

test('recordVisit(): a null entry (from a pending decision) is a no-op', () => {
  const list = recordVisit([{ hash: '#/a' }], null);
  assert.deepEqual(list.map((e) => e.hash), ['#/a']);
});

test('recordVisit(): a back-to-back repeat of the same hash is a no-op (same array reference)', () => {
  const list = [{ hash: '#/a' }];
  const next = recordVisit(list, { hash: '#/a' });
  assert.equal(next, list);
});

test('recordVisit(): revisiting an EARLIER page later still appends a new entry', () => {
  let list = [];
  list = recordVisit(list, { hash: '#/a' });
  list = recordVisit(list, { hash: '#/b' });
  list = recordVisit(list, { hash: '#/a' });
  assert.deepEqual(list.map((e) => e.hash), ['#/a', '#/b', '#/a']);
});

test('recordVisit(): caps at maxEntries, dropping the oldest first', () => {
  let list = [];
  for (let i = 0; i < 5; i++) list = recordVisit(list, { hash: `#/${i}` }, 3);
  assert.deepEqual(list.map((e) => e.hash), ['#/2', '#/3', '#/4']);
});
