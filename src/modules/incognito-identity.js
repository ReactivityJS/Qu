// Minting ADDITIONAL, independent identities — not moving one identity
// between devices (that's identity-transfer.js). Each "incognito identity"
// is a fully ordinary `QuIdentity` (own fingerprint, own ECDSA+ECDH
// keypair, own `~<fp>` User-Space) that happens to never get linked, in any
// published data, to the caller's main identity — a caller can "run as" one
// instead of their main fingerprint for a given Space (e.g. a calendar) so
// co-members only ever see the incognito fingerprint.
//
// No new crypto primitive anywhere in this file: it is 100% composition of
// QuIdentity.generate() (core/identity.js) and Qu.create({ identity,
// runtime }) (qu.js) — both already exist and are already exercised this
// way by this codebase's own tests (`Qu.create({ runtime: owner.runtime })`
// for a second, independent identity sharing one Runtime, see
// test/chat.test.mjs/examples/todo-lib.test.mjs). This module's entire
// value-add is the naming/storage/lifecycle convenience layer around that —
// exactly the same scope identity-transfer.js has relative to
// `QuIdentity#exportKeys()`/`importKeys()`.
//
// Storage is deliberately "bring your own persistence" (a plain object the
// caller reads/writes, e.g. to localStorage) — same stance
// identity-transfer.js and examples/*/space-app-browser.js already take for
// the MAIN identity's own keys, so this module stays fully unit-testable
// (only WebCrypto, no DOM/browser-only globals) without needing a fake
// localStorage.
//
// --- Honest limits (state these to the end user, not just in code) ---
// An incognito identity hides the caller's real fingerprint from:
//   - co-members of whatever Space it's used in (nothing published there
//     ever mentions the main fingerprint), and
//   - anyone only inspecting Space manifests/content.
// It does NOT hide anything from a relay operator correlating CONNECTION
// metadata: core/session.js's own class doc already establishes that
// multiple Sessions safely share one Runtime, but the NETWORK layer
// authenticates one identity per channel (network/handshake.js's
// authenticateChannel() binds a challenge/response to a single identity for
// that channel's lifetime) — running a main identity and an incognito one
// against the same relay at the same time means TWO separate WebSocket
// connections from the same device, which a relay operator logging
// connect-time/IP/TLS fingerprint can trivially correlate by timing alone.
// A stronger answer to that (Tor/mixnet transport) is a separate,
// transport-layer concern, out of scope here.

import { QuIdentity } from '../core/identity.js';
import { Qu } from '../qu.js';

/**
 * Generates a brand-new, independent identity and returns everything needed
 * to store and later re-enter it: `{ alias, fingerprint, keys, createdAt }`.
 * `alias` is a caller-chosen LOCAL label ("Kalender-Alias 1") for the
 * owner's own device-local UI only — it is never published anywhere, unlike
 * `Qu#publishProfile()`'s `alias`, which is a public display name for a
 * real identity. `keys` is the exact shape `QuIdentity#exportKeys()`/
 * `Qu.create({ identity })` already use (identity-transfer.js's own export
 * shape) — nothing new to serialize.
 */
export async function createIncognitoIdentity(alias) {
  if (!alias || typeof alias !== 'string') {
    throw new Error('[Incognito] createIncognitoIdentity() requires a non-empty local alias string.');
  }
  const identity = await QuIdentity.generate();
  return { alias, fingerprint: identity.fingerprint, keys: await identity.exportKeys(), createdAt: Date.now() };
}

/**
 * `store` is a plain object the caller persists however they like
 * (`{ [alias]: { fingerprint, keys, createdAt } }`) — these three functions
 * are pure reads/copies over it, no I/O of their own, same "bring your own
 * persistence" stance as identity-transfer.js relative to the main
 * identity's keys. `listIncognitoIdentities()` deliberately omits `keys`
 * from its return value (a UI picker needs alias/fingerprint/createdAt to
 * render a list, never the private key material) — use
 * `getIncognitoIdentity()` for the one entry actually being entered.
 */
export function listIncognitoIdentities(store = {}) {
  return Object.entries(store).map(([alias, entry]) => ({ alias, fingerprint: entry.fingerprint, createdAt: entry.createdAt }));
}

/** One stored entry by its local alias, `null` if unknown — includes `keys`, since this IS the lookup `enterIncognito()` below needs. */
export function getIncognitoIdentity(store = {}, alias) {
  return store[alias] ?? null;
}

/** Returns a NEW store object with `alias` removed — does not mutate `store` in place (same "pure function over a plain object" discipline as the two functions above), so a caller always knows the return value is what to persist. Removing an unknown alias is a harmless no-op, same "no special-cased absence" stance as modules/spaces.js's removeFromRole(). */
export function deleteIncognitoIdentity(store, alias) {
  const next = { ...store };
  delete next[alias];
  return next;
}

/**
 * "Runs as" one stored incognito identity for a given Runtime — builds and
 * returns a SEPARATE `Qu` instance sharing `mainQu.runtime` (`Qu.create({
 * runtime, identity })`, exactly the pattern this codebase's own tests
 * already use for a second, independent identity), NOT a new Runtime/Store:
 * same local cache, and — since sharing an EXISTING Runtime automatically
 * inherits whichever plugins its first creator installed (qu.js's
 * `wireRuntime()`/`defaultPlugins` mechanism) — the returned instance
 * already has `qu.createSpace()`/`qu.createEvent()`/etc. available without
 * re-installing them, same as any other identity sharing that Runtime would.
 * `plugins`, if given, are installed ADDITIONALLY on just this returned
 * instance (Qu.create()'s own `plugins` option) — for a plugin the caller
 * wants only under this alias, not Runtime-wide.
 *
 * Deliberately does NOT open a network connection itself — see this file's
 * doc comment on why that's a real, separate cost/leak surface (a second
 * WebSocket, correlatable by timing) the caller should decide on
 * explicitly, not have happen as a side effect of "entering" an alias. Call
 * `.connect(channel)` on the RETURNED instance yourself if this alias needs
 * live network sync.
 */
export async function enterIncognito(mainQu, storedKeys, { plugins = [] } = {}) {
  if (!mainQu?.runtime) throw new Error('[Incognito] enterIncognito() requires a Qu instance with a runtime (mainQu.runtime).');
  if (!storedKeys?.keys) throw new Error('[Incognito] enterIncognito() requires a stored entry with a `keys` field (see getIncognitoIdentity()).');
  return Qu.create({ runtime: mainQu.runtime, identity: storedKeys.keys, plugins });
}
