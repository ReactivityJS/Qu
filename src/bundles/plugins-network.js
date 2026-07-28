// Bundle 2/6 (Thema "network") — replication, transports, routing.
// Entirely optional: a Qu instance that never imports/uses any of this
// stays fully offline (see src/network/index.js's own doc). Independent
// of plugins-storage.js/plugins-data.js — pick only what an app needs.
export { authenticateChannel } from '../network/handshake.js';
export { Router } from '../network/router.js';
export { sendRoutedEvent, onRoutedEvent } from '../network/routed-events.js';
export { createWebSocketChannel } from '../network/transports/websocket-browser.js';
export { createWebRTCChannel } from '../network/transports/webrtc-browser.js';
export { createManualSignalingChannel } from '../network/transports/webrtc-manual-signaling.js';
export { PeerConnectionManager } from '../network/webrtc-peer-manager.js';
export { createWebRTCPlugin } from '../network/webrtc-plugin.js';
export { DefaultReplication } from '../network/replication/default.js';
export { ReplicationHub } from '../network/replication/hub.js';
export { assertReplicationProvider } from '../network/replication/provider.js';
export { createNetworkPlugin } from '../network/index.js';
export { createRateLimiter } from '../network/rate-limiter.js';
export { requireDirectWriterGate, rateLimitGate } from '../network/ingest-gate.js';
export { createConnectionGate } from '../network/connection-gate.js';
