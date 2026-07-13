// Ready-made `plugins` lists for `Qu.create({ plugins })` — the config-preset
// answer to "local only" / "+spaces" / "+spaces+network". Lives here, next to
// qu.js but outside core/, because it imports from modules/ and network/ —
// qu.js (Core) itself must never do that (see those files' own docs for why:
// Core stays a dumb, plugin-agnostic store).
import { createSpacesPlugin } from './modules/spaces.js';
import { createNetworkPlugin } from './network/index.js';
import { createWebRTCPlugin } from './network/webrtc-plugin.js';

/**
 * `Qu.create({ plugins: QU_PRESETS.spaces })`
 *   - local:        `[]` — the Core default already, spelled out for symmetry/docs.
 *   - spaces:       generic multi-writer Spaces (`qu.createSpace()`), still fully offline.
 *   - network:      spaces + `qu.connect()`/`qu.router`. Network without Spaces
 *                   is rarely useful (nothing shared to sync), so it's bundled in.
 *   - networkWebRTC: network + `qu.webrtc()` (direct peer-to-peer connections,
 *                   network/webrtc-plugin.js). A separate preset, not folded
 *                   into `network`, because WebRTC pulls in real bundle weight
 *                   (RTCPeerConnection wiring) that most apps — anything only
 *                   ever talking to its own relay over WebSocket — don't need
 *                   to pay for; see README's bundle-size section.
 *
 * Each property is a getter, not a static array: `createNetworkPlugin()` closes
 * over its own `router` state, so handing out the SAME plugin instance to two
 * independent `Qu.create()` calls would silently make them share one Router
 * (and its routes) across unrelated identities/runtimes. Reading `QU_PRESETS.x`
 * builds a fresh set of plugin instances every time, while keeping the plain
 * property-access ergonomics (`QU_PRESETS.spaces`, no function call).
 */
export const QU_PRESETS = {
  get local() { return []; },
  get spaces() { return [createSpacesPlugin()]; },
  get network() { return [createSpacesPlugin(), createNetworkPlugin()]; },
  get networkWebRTC() { return [createSpacesPlugin(), createNetworkPlugin(), createWebRTCPlugin()]; },
};
