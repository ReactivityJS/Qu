// Bundle 1/6 — Core only: the zero-trust store/session/identity/ACL
// machinery (src/core/**) plus the two adapters that make it usable with
// zero I/O dependency (MemoryAdapter, NullAdapter — both platform-agnostic,
// no `window`/`node:fs`). No network, no Spaces/Chat/Presence/Profiles
// modules, no UI — a consumer who only wants the raw local-first store
// (e.g. building their own sync layer, or just using QU as an in-memory
// signed/verified data structure) pays for none of that.
//
// Every export here is a pure re-export, never new logic — this file is
// composition only, so it can never drift out of sync with what src/core/
// actually contains beyond a missed re-export (caught by build-bundles.test.mjs).
export { Qu } from '../qu.js';
export { QuRuntime } from '../core/runtime.js';
export { QuStore, compareQubits } from '../core/store.js';
export { QuSession } from '../core/session.js';
export { QuIdentity, isValidFingerprint } from '../core/identity.js';
export { QuSpace } from '../core/space-handle.js';
export { QuClock } from '../core/clock.js';
export { QuPipeline } from '../core/pipeline.js';
export { debug, onDebug, enableConsoleDebug } from '../core/debug.js';
export { assertChannel, createLoopbackChannelPair } from '../core/channel.js';
export { assertStorageAdapter } from '../core/storage.js';
export { createVerifyPlugin } from '../core/verify.js';
export { createACLPlugin, filterForReader } from '../core/acl.js';
export { createIdentityACL } from '../core/identity-acl.js';
export {
  spaceIdOf, isUserSpaceId, userSpaceId, fingerprintOfUserSpace,
  randomSpaceId, isReservedProfilePath, RESERVED_PROFILE_PATHS,
} from '../core/space.js';
export { assertValidPattern } from '../core/pattern.js';
export { MemoryAdapter } from '../adapters/memory.js';
export { NullAdapter } from '../adapters/null.js';
