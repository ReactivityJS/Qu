import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, QuStore, MemoryAdapter, NullAdapter } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { createPlatformRegistry } from '../server/platform-registry.mjs';
import { withSilencedConsoleError } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeStoreWithAdminPrefix() {
  return new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'admin/', adapter: new NullAdapter(), replicate: false },
  ]);
}

test('admin/config/platform-modules: a signed+encrypted command from an admin fingerprint reconfigures the live registry', async () => {
  const admin = await QuIdentity.generate();
  const registry = createPlatformRegistry();
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix(), relayAdmins: [admin.fingerprint], platformRegistry: registry });

  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  await adminSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  assert.equal(relayApi.getAdminConfig().platformModules.contacts, true);
  await adminSession.publish('admin/config/platform-modules', { modules: { contacts: false, incognito: false } }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(20);

  assert.equal(relayApi.getAdminConfig().platformModules.contacts, false, 'the command must live-reconfigure the installed platform registry');
  assert.equal(relayApi.getAdminConfig().platformModules.incognito, false);
  assert.equal(relayApi.getAdminConfig().platformModules.notifications, true, 'an untouched module keeps its state');
});

test('admin/config/platform-modules: a non-admin fingerprint is rejected at the ACL layer, never reaches dispatch', async () => {
  const admin = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const registry = createPlatformRegistry();
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix(), relayAdmins: [admin.fingerprint], platformRegistry: registry });
  const outsiderSession = new QuSession(relayApi.relay.runtime, { identity: outsider });
  await outsiderSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  await withSilencedConsoleError(async () => {
    await assert.rejects(
      outsiderSession.publish('admin/config/platform-modules', { modules: { contacts: false } }, { encryptFor: [relayApi.relay.fingerprint] }),
      /ACL/,
    );
  });
  await wait(10);
  assert.equal(registry.isEnabled('contacts'), true, 'a rejected write must never reach platformRegistry.configure()');
});

test('getAdminConfig().platformModules is null when no platformRegistry was installed at all', async () => {
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix() });
  assert.equal(relayApi.getAdminConfig().platformModules, null);
});
