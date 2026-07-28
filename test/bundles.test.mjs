// Guards src/bundles/*.js against silent drift — each is pure
// re-export composition (see src/bundles/README.md), so the one thing
// that can actually go wrong is a typo'd/renamed export or a broken
// import path, which import() surfaces immediately as a rejected promise.
// ui.js/all.js are deliberately excluded here (they register Custom
// Elements at module-evaluation time, which throws outside a browser —
// same reason test/storage-adapters-browser.test.mjs's browser-only
// checks exist; those two are exercised for real via test/index.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const NODE_SAFE_BUNDLES = [
  'core', 'plugins-storage', 'plugins-network', 'plugins-data', 'app-space', 'core-plugins',
];

for (const name of NODE_SAFE_BUNDLES) {
  test(`src/bundles/${name}.js resolves and exports at least one binding`, async () => {
    const mod = await import(`../src/bundles/${name}.js`);
    const keys = Object.keys(mod);
    assert.ok(keys.length > 0, `${name}.js exported nothing`);
    for (const key of keys) assert.notEqual(mod[key], undefined, `${name}.js's "${key}" export is undefined`);
  });
}

test('core-plugins.js is exactly the union of core.js + plugins-storage.js + plugins-network.js + plugins-data.js + QU_PRESETS', async () => {
  const [core, storage, network, data, combined] = await Promise.all([
    import('../src/bundles/core.js'),
    import('../src/bundles/plugins-storage.js'),
    import('../src/bundles/plugins-network.js'),
    import('../src/bundles/plugins-data.js'),
    import('../src/bundles/core-plugins.js'),
  ]);
  const expected = new Set([...Object.keys(core), ...Object.keys(storage), ...Object.keys(network), ...Object.keys(data), 'QU_PRESETS']);
  assert.deepEqual(new Set(Object.keys(combined)), expected);
});

test('index.js is exactly core-plugins.js + app-space.js + the Node-safe UI bindings (viewKey/viewObject/bindKey/bindObject/buildPath/parsePathSegments/decideRoute/createRouter)', async () => {
  const [coreplugins, appSpace, index] = await Promise.all([
    import('../src/bundles/core-plugins.js'),
    import('../src/bundles/app-space.js'),
    import('../src/index.js'),
  ]);
  const nodeSafeUiKeys = ['viewKey', 'viewObject', 'bindKey', 'bindObject', 'buildPath', 'parsePathSegments', 'decideRoute', 'createRouter'];
  const expected = new Set([...Object.keys(coreplugins), ...Object.keys(appSpace), ...nodeSafeUiKeys]);
  assert.deepEqual(new Set(Object.keys(index)), expected);
});
