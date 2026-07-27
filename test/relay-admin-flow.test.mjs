import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, Qu, createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from '../src/index.js';
import { createServiceRegistry } from '../server/service-registry.mjs';
import { createRelayInfoRoutes } from '../server/relay-info-routes.mjs';
import { startTestRelayServer, stopTestRelayServer } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * End-to-end regression test for examples/relay-admin/app.mjs's exact
 * flow, over a REAL WebSocket connection (not a direct QuSession on the
 * relay's own runtime, see test/relay-admin.test.mjs for that narrower
 * unit-level coverage) — this is what actually caught a real bug while
 * building the app: a client Qu instance's LOCAL ingest() still enforces
 * the Core default ACL (only `~<fingerprint>/**` writable) unless
 * createSpacesPlugin() is installed client-side too, which would silently
 * reject an admin/service/<id> publish() before it ever reached the
 * network — a bug the narrower runtime-level tests can't see, since they
 * bypass the client's own local ACL entirely.
 */
test('relay-admin app flow over real WebSocket: admin toggles a service, an outsider\'s attempt is rejected server-side without throwing locally', async (t) => {
  const admin = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const registry = createServiceRegistry([{ id: 'forum', category: 'service', label: 'Forum', entry: '/x' }]);
  const relayIdentity = await QuIdentity.generate();
  const relayEpub = await crypto.subtle.exportKey('jwk', relayIdentity.encryptionKey);
  const [infoRoute] = createRelayInfoRoutes({ fingerprint: relayIdentity.fingerprint, epub: relayEpub });

  const { server, port, ...relayApi } = await startTestRelayServer({
    identity: relayIdentity, relayAdmins: [admin.fingerprint], serviceRegistry: registry,
  });
  await relayApi.relay.publishProfile();

  // Client channels must be closed BEFORE the server (stopTestRelayServer's
  // own doc comment: closing the server first can hang waiting on a
  // connection it doesn't know is still open) — one t.after, explicit order,
  // rather than relying on Node's hook-ordering semantics across two calls.
  const cleanups = [];
  t.after(async () => { await Promise.all(cleanups.map((fn) => fn())); await stopTestRelayServer(server); });

  async function connectAs(identity) {
    const qu = await Qu.create({ identity });
    // Exactly what examples/relay-admin/app.mjs does — see its own doc
    // comment on why createSpacesPlugin() is required here, not optional.
    qu.use(createNetworkPlugin()).use(createSpacesPlugin());
    await qu.session.trustPeer(relayIdentity.fingerprint, relayEpub);
    const channel = createWebSocketChannel(`ws://127.0.0.1:${port}/relay`);
    await channel.connect();
    const repl = await qu.connect(channel, { pushTopics: [''] });
    cleanups.push(async () => { repl.close(); await channel.close(); });
    return qu;
  }

  const adminQu = await connectAs(admin);
  const outsiderQu = await connectAs(outsider);

  assert.equal(registry.isEnabled('forum'), true);

  // The outsider's local publish() must NOT throw (see doc comment above —
  // the local write is accepted unconditionally, only the relay rejects
  // it), but the registry must stay unchanged.
  await outsiderQu.session.publish('admin/service/forum', { enabled: false }, { encryptFor: [relayIdentity.fingerprint] });
  await wait(150);
  assert.equal(registry.isEnabled('forum'), true, 'a non-admin\'s command must be rejected server-side, never take effect');

  await adminQu.session.publish('admin/service/forum', { enabled: false }, { encryptFor: [relayIdentity.fingerprint] });
  await wait(150);
  assert.equal(registry.isEnabled('forum'), false, 'the admin\'s command must take effect');

  // Sanity check on the /relay/info route this whole flow bootstraps from.
  assert.equal(infoRoute.match('/relay/info'), true);
});
