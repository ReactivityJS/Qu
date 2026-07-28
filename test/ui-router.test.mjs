import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRoute, createRouter } from '../src/ui/router.js';

const CATALOG = [
  { id: 'chat', category: 'service', label: 'Chat', entry: '/examples/chat/index.html', enabled: true }, // legacy fixed app, no spaceMode
  { id: 'forum', category: 'service', label: 'Forum', entry: '/services/forum/index.html', enabled: true, spaceMode: 'perInstance' },
  { id: 'cms', category: 'service', label: 'CMS', entry: '/services/cms/index.html', enabled: true, spaceMode: 'perUser' },
  { id: 'disabled-app', category: 'service', label: 'Disabled', entry: '/services/disabled/index.html', enabled: false, spaceMode: 'perInstance' },
  { id: 'mount-only', category: 'service', label: 'Mount Only', mount: './mount-only.mjs', spaceMode: 'perInstance' },
  { id: 'both', category: 'service', label: 'Both', entry: '/services/both/index.html', mount: './both.mjs', spaceMode: 'perInstance' },
  { id: 'no-loader', category: 'service', label: 'No Loader', spaceMode: 'perInstance' }, // declared, but neither entry nor mount — nothing to actually load
  { id: 'mounted-chat', category: 'service', label: 'Mounted Chat', mount: './mounted-chat.mjs', enabled: true }, // legacy fixed app, mount-only
];

test('decideRoute(): an empty hash is the home screen', () => {
  assert.deepEqual(decideRoute(''), { kind: 'home', segments: [] });
  assert.deepEqual(decideRoute('#/'), { kind: 'home', segments: [] });
});

test('decideRoute(): a bare, non-path hash (no leading #/) is also home, matching parsePathSegments()\'s own [] behavior', () => {
  assert.deepEqual(decideRoute('#foo'), { kind: 'home', segments: [] });
});

test('decideRoute(): a legacy bare fixed-app hash (no spaceMode / spaceMode:"fixed") still resolves directly, unaffected by space-first convergence', () => {
  const d = decideRoute('#/chat', { services: CATALOG });
  assert.equal(d.kind, 'app');
  assert.equal(d.appId, 'chat');
  assert.equal(d.entry, '/examples/chat/index.html');
  assert.deepEqual(d.segments, ['chat']);
});

test('decideRoute(): a legacy fixed-app hash with services still undefined is pending, not misread as a space', () => {
  const d = decideRoute('#/chat');
  assert.deepEqual(d, { kind: 'pending', segments: ['chat'] });
});

test('decideRoute(): `~<fp>` alone (no appId) is space-default — caller decides the built-in identity screen', () => {
  const d = decideRoute('#/~abc123');
  assert.equal(d.kind, 'space-default');
  assert.equal(d.spaceId, '~abc123');
  assert.deepEqual(d.segments, ['~abc123']);
});

test('decideRoute(): `u/<fp>` alone normalizes to the same space-default as `~<fp>`', () => {
  const a = decideRoute('#/~abc123', {});
  const b = decideRoute('#/u/abc123', {});
  assert.equal(a.kind, 'space-default');
  assert.equal(b.kind, 'space-default');
  assert.equal(a.spaceId, b.spaceId);
});

test('decideRoute(): `u` alone (no fingerprint segment) is NOT normalized — treated as a generic Space-UUID', () => {
  const d = decideRoute('#/u', { services: CATALOG });
  assert.equal(d.kind, 'space-default');
  assert.equal(d.spaceId, 'u');
});

test('decideRoute(): the fingerprint is not validated here — a malformed/empty `~` still yields a space-default decision', () => {
  const d = decideRoute('#/~');
  assert.equal(d.kind, 'space-default');
  assert.equal(d.spaceId, '~');
});

test('decideRoute(): `~<fp>/<appId>` resolves the app against the catalog, same as any other space', () => {
  const d = decideRoute('#/~abc123/cms/home', { services: CATALOG });
  assert.equal(d.kind, 'space');
  assert.equal(d.spaceId, '~abc123');
  assert.equal(d.appId, 'cms');
  assert.equal(d.entry, '/services/cms/index.html');
  assert.deepEqual(d.segments, ['~abc123', 'cms', 'home']);
});

test('decideRoute(): a generic Space-UUID with an appId resolves the same way as a `~fp` space', () => {
  const d = decideRoute('#/board-42/forum', { services: CATALOG });
  assert.equal(d.kind, 'space');
  assert.equal(d.spaceId, 'board-42');
  assert.equal(d.appId, 'forum');
  assert.equal(d.entry, '/services/forum/index.html');
});

test('decideRoute(): a generic Space-UUID alone (no appId) is space-default, exactly like a `~fp` alone', () => {
  const d = decideRoute('#/board-42', { services: CATALOG });
  assert.equal(d.kind, 'space-default');
  assert.equal(d.spaceId, 'board-42');
});

test('decideRoute(): an appId matching a DISABLED service is unknown, not space', () => {
  const d = decideRoute('#/board-42/disabled-app', { services: CATALOG });
  assert.equal(d.kind, 'unknown');
  assert.equal(d.spaceId, 'board-42');
  assert.equal(d.appId, 'disabled-app');
});

test('decideRoute(): an appId matching a service with only `mount` (no `entry`) resolves to space, mount surfaced, no entry key at all', () => {
  const d = decideRoute('#/board-42/mount-only', { services: CATALOG });
  assert.equal(d.kind, 'space');
  assert.equal(d.mount, './mount-only.mjs');
  assert.equal('entry' in d, false, 'no entry key when the matched service never declared one');
});

test('decideRoute(): a service declaring BOTH entry and mount surfaces both on the decision — the caller picks', () => {
  const d = decideRoute('#/board-42/both', { services: CATALOG });
  assert.equal(d.kind, 'space');
  assert.equal(d.entry, '/services/both/index.html');
  assert.equal(d.mount, './both.mjs');
});

test('decideRoute(): a service with NEITHER entry nor mount is unknown — declared metadata alone is nothing to load', () => {
  const d = decideRoute('#/board-42/no-loader', { services: CATALOG });
  assert.equal(d.kind, 'unknown');
});

test('decideRoute(): a legacy bare fixed-app hash resolves via `mount` too, not just `entry`', () => {
  const d = decideRoute('#/mounted-chat', { services: CATALOG });
  assert.equal(d.kind, 'app');
  assert.equal(d.appId, 'mounted-chat');
  assert.equal(d.mount, './mounted-chat.mjs');
  assert.equal('entry' in d, false);
});

test('decideRoute(): an appId with a loaded-but-non-matching catalog is unknown, spaceId+appId preserved', () => {
  const d = decideRoute('#/board-42/does-not-exist', { services: CATALOG });
  assert.deepEqual(d, { kind: 'unknown', spaceId: 'board-42', appId: 'does-not-exist', segments: ['board-42', 'does-not-exist'] });
});

test('decideRoute(): an EMPTY (but loaded) catalog with an appId given still yields unknown, not pending', () => {
  const d = decideRoute('#/board-42/forum', { services: [] });
  assert.equal(d.kind, 'unknown');
});

test('decideRoute(): a space + appId with services still undefined is pending, not unknown', () => {
  const d = decideRoute('#/board-42/forum');
  assert.deepEqual(d, { kind: 'pending', segments: ['board-42', 'forum'] });
});

test('decideRoute(): a `~fp` + appId with services still undefined is also pending', () => {
  const d = decideRoute('#/~abc123/cms');
  assert.deepEqual(d, { kind: 'pending', segments: ['~abc123', 'cms'] });
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
  assert.equal(seen[0].kind, 'space-default');
});

test('createRouter(): subsequent hash changes re-emit through the same handler', () => {
  const source = makeFakeHashSource('');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d.kind));
  router.start();
  source.navigate('#/~another-fp');
  assert.deepEqual(seen, ['home', 'space-default']);
});

test('createRouter(): setServices() re-resolves a pending space+app decision without any hash change', () => {
  const source = makeFakeHashSource('#/board-42/forum');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d));
  router.start();
  assert.equal(seen[0].kind, 'pending');

  router.setServices(CATALOG);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'space');
  assert.equal(seen[1].entry, '/services/forum/index.html');
});

test('createRouter(): setServices() also re-resolves a pending legacy fixed-app decision without any hash change', () => {
  const source = makeFakeHashSource('#/chat');
  const router = createRouter({ getHash: source.getHash, onHashChange: source.onHashChange });
  const seen = [];
  router.onRoute((d) => seen.push(d));
  router.start();
  assert.equal(seen[0].kind, 'pending');

  router.setServices(CATALOG);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].kind, 'app');
  assert.equal(seen[1].entry, '/examples/chat/index.html');
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
