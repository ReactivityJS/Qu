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
 *   - `qu.connect(channel, { pushTopics, role, group, metric, requireDirectWriter, rateLimiter })` —
 *     proves the peer's identity, then wires DefaultReplication over the
 *     channel. `role`/`group`/`metric` are opt-in — see network/router.js.
 *     `requireDirectWriter`/`rateLimiter` are opt-in incoming-push
 *     protections — see replication/default.js.
 *   - `qu.router` — the Router instance `connect()` (and, if also
 *     installed, `createWebRTCPlugin()`'s `qu.webrtc()`) shares, created
 *     lazily on first use.
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

  return {
    install(qu) {
      qu.connect = async (channel, { pushTopics = [], role = null, group = null, metric = 0, requireDirectWriter = false, rateLimiter = null } = {}) => {
        const peerFingerprint = await authenticateChannel(channel, qu.identity);
        const repl = new DefaultReplication(qu.runtime, channel, {
          getACL: qu.acl, peerFingerprint, pushTopics, router: role ? getRouter() : null, requireDirectWriter, rateLimiter,
        });
        if (role) getRouter().addRoute({ channelId: repl.channelId, channel, pushTopics, role, group, metric, peerFingerprint });
        return repl;
      };
      Object.defineProperty(qu, 'router', { get: getRouter, configurable: true });
    },
  };
}
