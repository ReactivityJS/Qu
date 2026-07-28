// Public entry point. Everything a developer needs is re-exported from
// here — internal file layout (core/adapters/network/data/modules) can
// change without breaking `import { ... } from 'qu-core'`.
//
// Composed from src/bundles/core-plugins.js (Core + storage/network/data
// plugins) + src/bundles/app-space.js (Spaces/membership/profiles/chat/
// presence) — the same two pieces scripts/build.mjs bundles separately
// for a size-conscious consumer, just re-exported together here as the
// "everything except UI" default. See src/bundles/README.md for the full
// bundle breakdown (core / plugins-* / app-space / ui / core-plugins / all).
//
// Deliberately NOT exported here — for opposite platform reasons:
// - adapters/node-fs.js and adapters/node-fs-file-storage.js import
//   node:fs/node:path, which would break any page that loads this barrel
//   in a browser (CORS/module-resolution errors, not just "unused code").
//   Node-only consumers (the relay, Node scripts) import them directly.
// - ui/components.js (and profile-components.js/people-search-components.js)
//   extend HTMLElement at module-evaluation time (a Custom Element class
//   declaration, not just a function body reference), which throws
//   immediately if imported in Node. Browser consumers import
//   src/bundles/ui.js (or the individual files) directly instead.
// Everything else here only *references* browser globals (WebSocket,
// RTCPeerConnection, localStorage, indexedDB, ...) inside function bodies —
// safe to import in Node too, it just can't be called there.
export * from './bundles/core-plugins.js';
export * from './bundles/app-space.js';

// ui/bindings.js, ui/hash-router.js, and ui/router.js (unlike
// ui/components.js and its Custom Element siblings, see the doc block
// above) never touch `window`/`document` at module-evaluation time — safe
// to import in Node too (router.js in particular takes its hash source as
// an injected parameter, see ui/router-browser.js for the real-window
// default), so they stay directly in this barrel same as before, even
// though src/bundles/ui.js also includes them (that bundle is "everything
// UI", this barrel is "everything except the actual Custom Elements").
export { viewKey, viewObject, bindKey, bindObject } from './ui/bindings.js';
export { buildPath, parsePathSegments } from './ui/hash-router.js';
export { decideRoute, createRouter } from './ui/router.js';
