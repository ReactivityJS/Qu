import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute, createRouter } from '../src/ui/router.js';

const CATALOG = [
  { id: 'forum', category: 'service', label: 'Forum', entry: '/services/forum/index.html', enabled: true },
  { id: 'disabled-app', category: 'service', label: 'Disabled', entry: '/services/disabled/index.html', enabled: false },
  { id: 'mount-only', category: 'service', label: 'Mount Only', mount: './mount-only.mjs' },
];

test('decideRoute(): an empty hash is the home screen', () => {
  assert.deepEqual(decideRoute(''), { kind: 'home', segments: [] });
  assert.deepEqual(decideRoute('#/'), { kind: 'home', segments: [] });
});

test('decideRoute(): a bare, non-path hash (no leading #/) is also home, matching parsePathSegments()\'s own [] behavior', () => {
  assert.deepEqual(decideRoute('#foo'), { kind: 'home', segments: [] });
});

test('decideRoute(): `~<fp>` is an identity route', () => {
  const d = decideRoute('#/~abc123');
  assert.equal(d.kind, 'identity');
  assert.equal(d.fingerprint, 'abc123');
});

test('decideRoute(): `u/<fp>` is the same identity route as `~<fp>`', () => {
  const a = decideRoute('#/~abc123', {});
  const b = decideRoute('#/u/abc123', {});
  assert.equal(a.kind, 'identity');
  assert.equal(b.kind, 'identity');
  assert.equal(a.fingerprint, b.fingerprint);
});

test('decideRoute(): `u` alone (no second segment) is NOT an identity route — falls through to app lookup', () => {
  const d = decideRoute('#/u', { services: CATALOG });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.appId, 'u');
});

test('decideRoute(): fingerprint is not validated here — a malformed/empty one still yields an identity decision', () => {
  const d = decideRoute('#/~');
  assert.equal(d.kind, 'identity');
  assert.equal(d.fingerprint, '');
});

test('decideRoute(): an appId not yet checked against any catalog (services undefined) is pending, not unknown', () => {
  const d = decideRoute('#/forum');
  assert.deepEqual(d, { kind: 'pending', appId: 'forum', segments: ['forum'] });
});

test('decideRoute(): an appId matching an enabled, entry-having catalog service is an app route', () => {
  const d = decideRoute('#/forum/board-1', { services: CATALOG });
  assert.equal(d.kind, 'app');
  assert.equal(d.appId, 'forum');
  assert.equal(d.entry, '/services/forum/index.html');
  assert.deepEqual(d.segments, ['forum', 'board-1']);
});

test('decideRoute(): an appId matching a DISABLED service is unknown, not app', () => {
  const d = decideRoute('#/disabled-app', { services: CATALOG });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.appId, 'disabled-app');
});

test('decideRoute(): an appId matching a service with only `mount` (no `entry`) is unknown — this phase can act on neither', () => {
  const d = decideRoute('#/mount-only', { services: CATALOG });
  assert.equal(d.kind, 'unknown');
});

test('decideRoute(): an appId with a loaded-but-non-matching catalog is unknown, appId preserved', () => {
  const d = decideRoute('#/does-not-exist', { services: CATALOG });
  assert.deepEqual(d, { kind: 'unknown', appId: 'does-not-exist', segments: ['does-not-exist'] });
});

test('decideRoute(): an EMPTY (but loaded) catalog still yields unknown, not pending — loaded-empty is not the same as not-yet-loaded', () => {
  const d = decideRoute('#/forum', { services: [] });
  assert.equal(d.kind, 'unknown');
});

function makeFakeHashSource(initial = '') {
  let hash = initial;
  const listeners = new Set();
  return {
    getHash: () => hash,
    onHashChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    navigate(newHash) { hash = newHash; listeners.forEach((fn) => fn()); },
  };
}

test('createRouter(): start() calls the handler once, synchronously, with the current hash\'s decision', () => {
  const source = makeFakeHashSource('#/~my-fp');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d));
  router.start();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'identity');
});

test('createRouter(): subsequent hash changes re-emit through the same handler', () => {
  const source = makeFakeHashSource('');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d.kind));
  router.start();
  source.navigate('#/~another-fp');
  assert.deepEqual(seen, ['home', 'identity']);
});

test('createRouter(): setServices() re-resolves a pending decision without any hash change', () => {
  const source = makeFakeHashSource('#/forum');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d));
  router.start();
  assert.equal(seen[0].kind, 'pending');

  router.setServices(CATALOG);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'app');
  assert.equal(seen[1].entry, '/services/forum/index.html');
});

test('createRouter(): start() returns an unsubscribe function that stops further emissions', () => {
  const source = makeFakeHashSource('');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d.kind));
  const stop = router.start();
  stop();
  source.navigate('#/~fp');
  assert.deepEqual(seen, ['home'], 'no further emissions after unsubscribing');
});
