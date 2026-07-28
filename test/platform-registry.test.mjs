import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformRegistry, PLATFORM_MODULES } from '../server/platform-registry.mjs';

test('createPlatformRegistry(): every known module is enabled by default', () => {
  const registry = createPlatformRegistry();
  for (const { id } of PLATFORM_MODULES) {
    assert.equal(registry.isEnabled(id), true, `${id} should default to enabled`);
  }
  assert.equal(registry.list().length, PLATFORM_MODULES.length);
});

test('createPlatformRegistry(overrides): a startup override narrows the default', () => {
  const registry = createPlatformRegistry({ contacts: false, incognito: false });
  assert.equal(registry.isEnabled('contacts'), false);
  assert.equal(registry.isEnabled('incognito'), false);
  assert.equal(registry.isEnabled('notifications'), true, 'unrelated modules keep their default');
});

test('setEnabled(): flips a single module live; unknown id is a no-op, not a throw', () => {
  const registry = createPlatformRegistry();
  assert.equal(registry.setEnabled('cms-homepage', false), true);
  assert.equal(registry.isEnabled('cms-homepage'), false);

  assert.equal(registry.setEnabled('does-not-exist', true), false);
});

test('configure(): batch-reconfigures several modules at once from a { modules } payload; unknown ids ignored', () => {
  const registry = createPlatformRegistry();
  registry.configure({ modules: { contacts: false, directory: false, 'does-not-exist': true } });
  assert.equal(registry.isEnabled('contacts'), false);
  assert.equal(registry.isEnabled('directory'), false);
  assert.equal(registry.isEnabled('notifications'), true);

  registry.configure({}); // no `modules` key at all — must be a no-op, not a throw
  assert.equal(registry.isEnabled('contacts'), false, 'a modules-less payload must not reset anything');
});

test('getConfig(): the exact { [id]: boolean } shape admin/config/platform-modules itself uses', () => {
  const registry = createPlatformRegistry({ contacts: false });
  const config = registry.getConfig();
  assert.deepEqual(config, {
    contacts: false,
    'cms-homepage': true,
    notifications: true,
    directory: true,
    incognito: true,
  });
});

test('list(): metadata (id + label) alongside the live enabled flag', () => {
  const registry = createPlatformRegistry();
  const contacts = registry.list().find((m) => m.id === 'contacts');
  assert.equal(contacts.label, 'Kontaktliste');
  assert.equal(contacts.enabled, true);
});
