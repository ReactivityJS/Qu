// Public entry point. Everything a developer needs is re-exported from
// here — internal file layout (core/adapters/network/data/modules) can
// change without breaking `import { ... } from 'qu-core'`.
//
// The only things deliberately NOT exported here are adapters/node-fs.js
// and adapters/node-fs-file-storage.js — they import node:fs/node:path,
// which would break any page that loads this barrel in a browser (CORS/
// module-resolution errors, not just "unused code"). Node-only consumers
// (the relay, Node scripts) import them directly from their own files.
// Everything else here only *references* browser globals (WebSocket,
// RTCPeerConnection, localStorage, indexedDB, ...) inside function bodies —
// safe to import in Node too, it just can't be called there.

// Recommended entry point for most applications:
export { Qu } from './qu.js';

// Underlying primitives — still directly usable for advanced composition.
export { QuRuntime } from './core/runtime.js';
export { QuStore } from './core/store.js';
export { QuSession } from './core/session.js';
export { QuIdentity } from './core/identity.js';
export { QuClock } from './core/clock.js';
export { debug, onDebug, enableConsoleDebug } from './core/debug.js';
export { assertChannel, createLoopbackChannelPair } from './core/channel.js';
export { assertStorageAdapter } from './core/storage.js';
export { createVerifyPlugin } from './core/verify.js';
export { createACLPlugin, filterForReader } from './core/acl.js';
export { createIdentityACL } from './core/identity-acl.js';
export {
  spaceIdOf,
  isUserSpaceId,
  userSpaceId,
  fingerprintOfUserSpace,
  randomSpaceId,
} from './core/space.js';

// Category 1 — storage adapters. Memory/Null are what make the Core
// local-only/offline by default; Local/Session/IndexedDB cover the browser,
// node-fs*.js (Node-only, see note above) covers the filesystem.
export { MemoryAdapter } from './adapters/memory.js';
export { NullAdapter } from './adapters/null.js';
export { MemoryFileStorageAdapter } from './adapters/file-storage-memory.js';
export { LocalStorageAdapter } from './adapters/local-storage.js';
export { SessionStorageAdapter } from './adapters/session-storage.js';
export { IndexedDBAdapter } from './adapters/indexeddb.js';

// Category 2 — network: replication, transports, routing. Entirely optional
// — a Qu instance that never imports/uses any of this stays fully offline.
export { authenticateChannel } from './network/handshake.js';
export { Router } from './network/router.js';
export { sendRoutedEvent, onRoutedEvent } from './network/routed-events.js';
export { createWebSocketChannel } from './network/transports/websocket-browser.js';
export { createWebRTCChannel } from './network/transports/webrtc-browser.js';
export { PeerConnectionManager } from './network/webrtc-peer-manager.js';
export { DefaultReplication } from './network/replication/default.js';
export { ReplicationHub } from './network/replication/hub.js';
export { assertReplicationProvider } from './network/replication/provider.js';
export { createNetworkPlugin } from './network/index.js';

// Category 3 — data: references (obj://, key://, file://) and files.
export {
  isReference, parseReference, objRef, keyRef, fileRef,
  resolveReference, resolveValue, createReferenceHandlerPlugin,
} from './data/references.js';
export { publishFile, reassembleFile, missingChunks } from './data/files/manifest.js';
export { DefaultFileTransfer } from './data/files/transfer.js';
export { assertFileStorageAdapter } from './data/files/contract.js';
export { shareFile, resolveFileRef, createFileHandlerPlugin } from './data/files/index.js';

// Application modules — optional, built entirely on the public Qu/Session
// API (see modules/spaces.js, modules/chat.js). createSpacesPlugin() is
// what makes qu.createSpace() exist at all — the Core default ACL
// (core/identity-acl.js) only ever grants `~<your fingerprint>`.
export { createSpaceACLResolver, createSpace, createSpacesPlugin } from './modules/spaces.js';
export {
  sendMessage, listMessages, onMessage, createChatRoom,
  markRead, getReadReceipts, onReadReceipt,
  setPresence, getPresence, onPresenceChange, startHeartbeat,
  createChatPlugin,
} from './modules/chat.js';
