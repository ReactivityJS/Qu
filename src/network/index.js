// Network plugin: the `qu.connect()`/`qu.router`/`qu.webrtc()` sugar that
// used to be hardcoded into the Qu facade. DefaultReplication, Router and
// PeerConnectionManager remain directly usable without this (see
// replication/default.js, router.js, webrtc-peer-manager.js) — this only
// adds the convenience layer, and only for Qu instances that opt into it.
import { authenticateChannel } from './handshake.js';
import { Router } from './router.js';
import { DefaultReplication } from './replication/default.js';
import { PeerConnectionManager } from './webrtc-peer-manager.js';

/**
 * `qu.use(createNetworkPlugin())` attaches:
 *   - `qu.connect(channel, { pushTopics, role, group, metric })` — proves
 *     the peer's identity, then wires DefaultReplication over the channel.
 *     `role`/`group`/`metric` are opt-in — see network/router.js.
 *   - `qu.router` — the Router instance `connect()`/`webrtc()` share,
 *     created lazily on first use.
 *   - `qu.webrtc(signalingChannel, opts)` — a PeerConnectionManager for
 *     direct peer connections (see network/webrtc-peer-manager.js).
 */
export function createNetworkPlugin() {
  let router = null;
  function getRouter() {
    if (!router) router = new Router();
    return router;
  }

  return {
    install(qu) {
      qu.connect = async (channel, { pushTopics = [], role = null, group = null, metric = 0 } = {}) => {
        const peerFingerprint = await authenticateChannel(channel, qu.identity);
        const repl = new DefaultReplication(qu.runtime, channel, {
          getACL: qu.acl, peerFingerprint, pushTopics, router: role ? getRouter() : null,
        });
        if (role) getRouter().addRoute({ channelId: repl.channelId, channel, pushTopics, role, group, metric, peerFingerprint });
        return repl;
      };
      Object.defineProperty(qu, 'router', { get: getRouter, configurable: true });
      qu.webrtc = (signalingChannel, opts = {}) => new PeerConnectionManager(qu, { router: getRouter(), signalingChannel, ...opts });
    },
  };
}
