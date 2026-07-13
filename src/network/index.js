// Network plugin: the `qu.connect()`/`qu.router` sugar that used to be
// hardcoded into the Qu facade. DefaultReplication and Router remain
// directly usable without this (see replication/default.js, router.js) —
// this only adds the convenience layer, and only for Qu instances that opt
// into it. Deliberately does NOT import webrtc-peer-manager.js (that's
// network/webrtc-plugin.js, a separate opt-in plugin) — WebRTC pulls in
// real, non-trivial RTCPeerConnection wiring that an app talking only to
// its own relay over WebSocket should never have to bundle.
import { authenticateChannel } from './handshake.js';
import { Router } from './router.js';
import { DefaultReplication } from './replication/default.js';

/**
 * `qu.use(createNetworkPlugin())` attaches:
 *   - `qu.connect(channel, { pushTopics, subscribeOwnSpace, allowDynamicSubscribe, maxDynamicTopics, role, group, metric, requireDirectWriter, rateLimiter, ingestGate })` —
 *     proves the peer's identity, then wires DefaultReplication over the
 *     channel. `role`/`group`/`metric` are opt-in — see network/router.js.
 *     `requireDirectWriter`/`rateLimiter`/`ingestGate` are opt-in incoming-
 *     push protections — see replication/default.js and
 *     network/ingest-gate.js. `subscribeOwnSpace` (default `true`) asks
 *     the peer to push `qu.userSpaceId`'s own topic back — "at least sync
 *     my own Space across devices" without any extra configuration; pass
 *     `false` to opt out (e.g. a guest/anonymous connection with no own
 *     Space, or a deliberately asymmetric connection). `allowDynamicSubscribe`/
 *     `maxDynamicTopics` (both off/default-capped unless set) let THIS side
 *     honor the peer's own runtime qu.subscribe() requests — relevant for
 *     direct/P2P connections (e.g. qu.webrtc()), where either side can play
 *     "the relay" for the other; a dedicated relay process normally sets
 *     these via createRelay()/ReplicationHub instead — see
 *     replication/default.js's constructor doc for the full semantics.
 *   - `qu.router` — the Router instance `connect()` (and, if also
 *     installed, `createWebRTCPlugin()`'s `qu.webrtc()`) shares, created
 *     lazily on first use.
 *   - The `subscribeDispatch` hook (`qu.setSubscribeHandler()`, see
 *     core/space-handle.js) every node's `on()`/`map()` calls — fans a
 *     topic out to `ensureSynced()` on every currently connected
 *     DefaultReplication this Qu instance has (tracked internally,
 *     pruned automatically when a channel closes), so a listener actually
 *     receives what a connected relay/peer already has, not just local
 *     activity.
 *
 * For direct peer-to-peer connections (`qu.webrtc(...)`), additionally
 * `qu.use(createWebRTCPlugin())` (network/webrtc-plugin.js) — kept separate
 * so it's only ever bundled by apps that actually use it.
 */
export function createNetworkPlugin() {
  let router = null;
  function getRouter() {
    if (!router) router = new Router();
    return router;
  }
  const activeRepls = new Set();

  return {
    install(qu) {
      qu.connect = async (channel, {
        pushTopics = [], subscribeOwnSpace = true, role = null, group = null, metric = 0,
        requireDirectWriter = false, rateLimiter = null, ingestGate = [],
        allowDynamicSubscribe = false, maxDynamicTopics = 200,
      } = {}) => {
        const peerFingerprint = await authenticateChannel(channel, qu.identity);
        const repl = new DefaultReplication(qu.runtime, channel, {
          getACL: qu.acl, peerFingerprint, pushTopics, router: role ? getRouter() : null, requireDirectWriter, rateLimiter, ingestGate,
          allowDynamicSubscribe, maxDynamicTopics,
        });
        activeRepls.add(repl);
        channel.onClose(() => activeRepls.delete(repl));
        if (role) getRouter().addRoute({ channelId: repl.channelId, channel, pushTopics, role, group, metric, peerFingerprint });
        if (subscribeOwnSpace && qu.userSpaceId) {
          // Bare id, no trailing slash — matches the Space's own root
          // document too (e.g. a direct qu.own.put(...)), not just its
          // children, same convention as everywhere else pushTopics
          // addresses a whole Space (see README's App-Space section).
          repl.subscribe(qu.userSpaceId).catch((e) => console.error('[Network] subscribeOwnSpace fehlgeschlagen:', e));
        }
        return repl;
      };
      Object.defineProperty(qu, 'router', { get: getRouter, configurable: true });
      qu.setSubscribeHandler(async (session, topic) => {
        await Promise.all([...activeRepls].map((repl) => repl.ensureSynced(topic).catch((e) => console.error(`[Network] ensureSynced("${topic}") fehlgeschlagen:`, e))));
      });
    },
  };
}
