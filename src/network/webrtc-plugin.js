import { PeerConnectionManager } from './webrtc-peer-manager.js';

/**
 * `qu.use(createWebRTCPlugin())` attaches `qu.webrtc(signalingChannel, opts)`
 * — split out from createNetworkPlugin() (network/index.js) specifically so
 * an app that only ever talks to its own relay over WebSocket never bundles
 * WebRTC code at all: webrtc-peer-manager.js pulls in
 * transports/webrtc-browser.js (the RTCPeerConnection wiring), which alone
 * is real, non-trivial weight — dead code for the common "no direct P2P"
 * case if it were pulled in unconditionally.
 *
 * Requires createNetworkPlugin() to already be installed: shares the SAME
 * `qu.router` that `qu.connect(channel, { role, group, metric })` uses, not
 * a second, independent Router — a peer connected via `connect()` and one
 * reached via `webrtc()` must be able to compete in the same routing
 * decision (§ Router & WebRTC in API.md). install() throws a clear error if
 * `qu.router` isn't there yet rather than silently building an unrelated
 * Router that would never see connect()'s channels.
 */
export function createWebRTCPlugin() {
  return {
    install(qu) {
      if (!('router' in qu)) {
        throw new Error('[WebRTC] createWebRTCPlugin() braucht createNetworkPlugin() für den gemeinsamen Router — zuerst qu.use(createNetworkPlugin()) aufrufen.');
      }
      qu.webrtc = (signalingChannel, opts = {}) => new PeerConnectionManager(qu, { router: qu.router, signalingChannel, ...opts });
    },
  };
}
