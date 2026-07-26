import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServiceRegistry } from '../server/service-registry.mjs';
import { QuIdentity, QuSession } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { makeRuntime } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('ServiceRegistry: routes() only match while the service is enabled, without re-registering routes', () => {
  const registry = createServiceRegistry([
    { id: 'a', category: 'service', label: 'A', routes: [{ match: (p) => p === '/a', handle: () => {} }] },
  ]);
  const [route] = registry.routes(); // built ONCE — the same route object is reused below
  assert.equal(route.match('/a'), true);

  registry.setEnabled('a', false);
  assert.equal(route.match('/a'), false, 'a live flag flip must be visible to an already-built route without rebuilding routes()');

  registry.setEnabled('a', true);
  assert.equal(route.match('/a'), true);
});

test('ServiceRegistry: setEnabled() on an unknown id is a no-op, not a throw', () => {
  const registry = createServiceRegistry([]);
  assert.equal(registry.setEnabled('does-not-exist', true), false);
});

test('ServiceRegistry: toJSON() exposes only metadata, never route/gate functions', () => {
  const registry = createServiceRegistry([
    { id: 'a', category: 'service', label: 'A', description: 'desc', entry: '/a', routes: [{ match: () => true, handle: () => {} }] },
  ]);
  const [json] = registry.toJSON();
  assert.deepEqual(json, { id: 'a', category: 'service', label: 'A', description: 'desc', entry: '/a', enabled: true });
});

test('ServiceRegistry.attachStore(): a plain signed write to relay-services/<id> shows up live, no restart', async () => {
  const registry = createServiceRegistry([]);
  const runtime = makeRuntime();
  registry.attachStore(runtime, { prefix: 'relay-services/' });

  const alice = await QuIdentity.generate();
  const session = new QuSession(runtime, { identity: alice });
  await session.publish('relay-services/forum-mirror', { category: 'service', label: 'Forum Mirror', entry: 'https://forum.example.com', enabled: true });
  await wait(10);

  assert.equal(registry.isEnabled('forum-mirror'), true);
  assert.equal(registry.get('forum-mirror').label, 'Forum Mirror');
  assert.ok(registry.toJSON().some((s) => s.id === 'forum-mirror'));
});

test('ServiceRegistry.attachStore(): a tombstoned entry ({ deleted: true }) is removed, not kept as a dead entry', async () => {
  const registry = createServiceRegistry([]);
  const runtime = makeRuntime();
  registry.attachStore(runtime, { prefix: 'relay-services/' });

  const alice = await QuIdentity.generate();
  const session = new QuSession(runtime, { identity: alice });
  await session.publish('relay-services/temp', { category: 'service', label: 'Temp', entry: '/x' });
  await wait(10);
  assert.ok(registry.get('temp'));

  await session.publish('relay-services/temp', { deleted: true });
  await wait(10);
  assert.equal(registry.get('temp'), null);
});

test('ServiceRegistry.attachStore(): a store-defined entry can never shadow a code-defined one on id collision', async () => {
  const registry = createServiceRegistry([
    { id: 'chat', category: 'service', label: 'Real Chat', entry: '/examples/chat/index.html' },
  ]);
  const runtime = makeRuntime();
  registry.attachStore(runtime, { prefix: 'relay-services/' });

  const alice = await QuIdentity.generate();
  const session = new QuSession(runtime, { identity: alice });
  await session.publish('relay-services/chat', { category: 'service', label: 'Fake Chat', entry: 'https://evil.example.com' });
  await wait(10);

  assert.equal(registry.get('chat').label, 'Real Chat', 'the code-defined "chat" entry must win over a same-id store-defined one');
});

test('createRelay({ relayAdmins, serviceRegistry }): only a relayAdmins fingerprint may write relay-services/<id>', async () => {
  const registry = createServiceRegistry([]);
  const admin = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const relayApi = await createRelay({ relayAdmins: [admin.fingerprint], serviceRegistry: registry });

  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  const outsiderSession = new QuSession(relayApi.relay.runtime, { identity: outsider });

  await adminSession.publish('relay-services/from-admin', { category: 'service', label: 'From Admin', entry: '/x' });
  await wait(10);
  assert.equal(registry.get('from-admin')?.label, 'From Admin');

  await assert.rejects(
    outsiderSession.publish('relay-services/from-outsider', { category: 'service', label: 'From Outsider', entry: '/y' }),
    /ACL/,
  );
  await wait(10);
  assert.equal(registry.get('from-outsider'), null);
});
