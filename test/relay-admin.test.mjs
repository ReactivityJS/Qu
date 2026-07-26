import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, QuStore, MemoryAdapter, NullAdapter } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { createServiceRegistry } from '../server/service-registry.mjs';
import { withSilencedConsoleError } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Matches index.js's real store shape (admin/ mounted on a NullAdapter, replicate:false) rather than relying on createRelay()'s bare default store, since the admin channel is meant to be ephemeral/non-replicated in real deployments. */
function makeStoreWithAdminPrefix() {
  return new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'admin/', adapter: new NullAdapter(), replicate: false },
  ]);
}

async function setup({ admins }) {
  const registry = createServiceRegistry([
    { id: 'forum', category: 'service', label: 'Forum', entry: '/examples/forum/index.html' },
  ]);
  const relayApi = await createRelay({ store: makeStoreWithAdminPrefix(), relayAdmins: admins, serviceRegistry: registry });
  return { registry, relayApi };
}

test('admin toggle: a signed+encrypted admin/service/<id> command from an allow-listed fingerprint flips the registry live', async () => {
  const admin = await QuIdentity.generate();
  const { registry, relayApi } = await setup({ admins: [admin.fingerprint] });
  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  await adminSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  assert.equal(registry.isEnabled('forum'), true);
  await adminSession.publish('admin/service/forum', { enabled: false }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(10);
  assert.equal(registry.isEnabled('forum'), false, 'the command must be decrypted and dispatched to setEnabled()');
});

test('admin toggle: a correctly-signed command from a NON-admin fingerprint is rejected at the ACL layer, never reaches dispatch', async () => {
  const admin = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const { registry, relayApi } = await setup({ admins: [admin.fingerprint] });
  const outsiderSession = new QuSession(relayApi.relay.runtime, { identity: outsider });
  await outsiderSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  await withSilencedConsoleError(async () => {
    await assert.rejects(
      outsiderSession.publish('admin/service/forum', { enabled: false }, { encryptFor: [relayApi.relay.fingerprint] }),
      /ACL/,
    );
  });
  await wait(10);
  assert.equal(registry.isEnabled('forum'), true, 'a rejected write must never reach the registry');
});

test('admin toggle: a plaintext (unencrypted) admin event is ignored, not a crash', async () => {
  const admin = await QuIdentity.generate();
  const { registry, relayApi } = await setup({ admins: [admin.fingerprint] });
  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });

  // Deliberately bypasses Session.publish()'s own encryption (writes a
  // plain, unencrypted value) — same admin fingerprint, same ACL pass,
  // but the relay's decryptWith() call must fail closed (caught, ignored),
  // never throw out of the listener or crash the process.
  await withSilencedConsoleError(async () => {
    await adminSession.publish('admin/service/forum', { enabled: false });
  });
  await wait(10);
  assert.equal(registry.isEnabled('forum'), true, 'an unencrypted command must never be treated as a valid one');
});

test('admin toggle: an unknown service id in an otherwise-valid admin command is a no-op, not a crash', async () => {
  const admin = await QuIdentity.generate();
  const { relayApi } = await setup({ admins: [admin.fingerprint] });
  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  await adminSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  await adminSession.publish('admin/service/does-not-exist', { enabled: false }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(10); // must not throw / crash the relay's listener
});

test('admin toggle: a ttl\'d command reverts to the prior state on its own after expiry, and a later command cancels a pending revert', async () => {
  const admin = await QuIdentity.generate();
  const { registry, relayApi } = await setup({ admins: [admin.fingerprint] });
  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  await adminSession.trustPeer(relayApi.relay.fingerprint, await crypto.subtle.exportKey('jwk', relayApi.relay.identity.encryptionKey));

  await adminSession.publish('admin/service/forum', { enabled: false, ttl: 30 }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(10);
  assert.equal(registry.isEnabled('forum'), false, 'the temporary toggle takes effect immediately');
  await wait(40);
  assert.equal(registry.isEnabled('forum'), true, 'the temporary toggle must revert on its own after ttl expires');

  // A second ttl'd command must cancel the first's pending revert — the
  // second one's OWN revert (to whatever was true right before IT landed)
  // is what fires, not a leftover timer from the first.
  await adminSession.publish('admin/service/forum', { enabled: false, ttl: 20 }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(5);
  await adminSession.publish('admin/service/forum', { enabled: true, ttl: 1000 }, { encryptFor: [relayApi.relay.fingerprint] });
  await wait(30); // past the SECOND command's ttl (20ms), well before the third's (1000ms)
  assert.equal(registry.isEnabled('forum'), true, 'the second command\'s pending revert must have been cancelled by the third command, not fired late and stomped its effect');
});
