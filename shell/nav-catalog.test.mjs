import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleCatalogEntries, sortCatalog } from './nav-catalog.mjs';

test('visibleCatalogEntries(): drops admin-category, disabled, and loader-less definitions; keeps mount-only ones', () => {
  const services = [
    { id: 'forum', category: 'service', label: 'Forum', entry: '/x', enabled: true },
    { id: 'relay-admin', category: 'admin', label: 'Relay-Admin', entry: '/y', enabled: true },
    { id: 'disabled-app', category: 'service', label: 'Disabled', entry: '/z', enabled: false },
    { id: 'mount-only', category: 'service', label: 'Mount Only', mount: './x.mjs' },
    { id: 'no-loader', category: 'service', label: 'No Loader' },
  ];
  const visible = visibleCatalogEntries(services);
  assert.deepEqual(visible.map((s) => s.id), ['forum', 'mount-only']);
});

test('visibleCatalogEntries(): a definition with enabled left undefined is treated as enabled (only enabled===false is excluded)', () => {
  const services = [{ id: 'a', category: 'service', label: 'A', entry: '/a' }];
  assert.equal(visibleCatalogEntries(services).length, 1);
});

test('sortCatalog(): orders by category first (service, example, documentation, custom), then navOrder, then label', () => {
  const list = [
    { id: 'doc-a', category: 'documentation', label: 'Z Doc' },
    { id: 'svc-b', category: 'service', label: 'B Service', navOrder: 2 },
    { id: 'svc-a', category: 'service', label: 'A Service', navOrder: 1 },
    { id: 'custom-a', category: 'custom', label: 'Custom' },
    { id: 'example-a', category: 'example', label: 'Example' },
  ];
  const sorted = sortCatalog(list).map((s) => s.id);
  assert.deepEqual(sorted, ['svc-a', 'svc-b', 'example-a', 'doc-a', 'custom-a']);
});

test('sortCatalog(): missing navOrder sorts after any entry that has one, within the same category', () => {
  const list = [
    { id: 'no-order', category: 'service', label: 'No Order' },
    { id: 'has-order', category: 'service', label: 'Has Order', navOrder: 5 },
  ];
  assert.deepEqual(sortCatalog(list).map((s) => s.id), ['has-order', 'no-order']);
});

test('sortCatalog(): an unknown category sorts after all known categories', () => {
  const list = [
    { id: 'unknown-cat', category: 'mystery', label: 'Mystery' },
    { id: 'known', category: 'custom', label: 'Known' },
  ];
  assert.deepEqual(sortCatalog(list).map((s) => s.id), ['known', 'unknown-cat']);
});

test('sortCatalog(): does not mutate the input array', () => {
  const list = [{ id: 'b', category: 'service', label: 'B' }, { id: 'a', category: 'service', label: 'A' }];
  const original = [...list];
  sortCatalog(list);
  assert.deepEqual(list, original);
});
