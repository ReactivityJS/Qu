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
// Two storage tiers coexist, deliberately: `createIncognitoIdentity()`/
// `listIncognitoIdentities()`/`getIncognitoIdentity()`/`deleteIncognitoIdentity()`
// below are "bring your own persistence" (a plain object the caller reads/
// writes however they like) — same stance identity-transfer.js and
// examples/*/space-app-browser.js take for the MAIN identity's own keys, so
// this half stays fully unit-testable (only WebCrypto, no DOM/browser-only
// globals) without needing a fake localStorage. `saveIncognitoIdentity()`/
// `loadIncognitoStore()`/`removeIncognitoIdentity()`/
// `onIncognitoIdentitiesChange()` further down are the CONCRETE, QuBit-backed
// answer to "persist the alias list itself, encrypted, so it survives a
// reload and syncs across devices" — see their own doc comments.
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

// --- Persisted, encrypted-to-self, replicable alias list ---
//
// The concrete answer to "persist the alias list itself, so it survives a
// reload AND syncs across this identity's own devices": one QuBit per
// alias, under the MAIN identity's own Space (`~<fp>/incognito/<alias>`),
// encrypted to the main identity's OWN encryption key (`encryptFor:
// [qu.fingerprint]` — the existing encrypt-to-self path
// modules/profiles.js's setProfileAttr() already exercises, see its own doc
// comment; no new crypto here either). A relay mirroring this Space sees
// only an opaque encrypted blob per alias — the COUNT of aliases and their
// write timestamps, never the label or which fingerprint it decrypts to. A
// second device holding the same main identity's `encPriv` decrypts it
// exactly like any other Space content it already replicates —
// multi-device sync of "which aliases do I have" falls out of the existing
// replication/encryption model for free, no new mechanism needed.
const INCOGNITO_PREFIX = 'incognito';

/**
 * Persists one alias entry (as returned by `createIncognitoIdentity()`)
 * under the caller's own Space, encrypted to themselves. Overwrites any
 * existing entry under the same `alias` (LWW, same LWW semantics as any
 * other `put()`) — re-saving the same alias with new `createdAt`/`keys`
 * would be unusual in practice, but not guarded against here, same "trust
 * the caller" stance every other `put()`-based module in this directory takes.
 *
 * `connectionMode` ('sequential' | 'simultaneous', default 'sequential'):
 * a per-alias PREFERENCE for whether a UI should keep the main identity's
 * relay connection open while this alias is also connected. This is
 * deliberately just a stored preference, not something this module (or any
 * other Qu-core code) enforces — the actual connect/disconnect
 * orchestration is a caller/UI concern. What IS structural, and needs no
 * enforcement here either: network/handshake.js's authenticateChannel()
 * already binds exactly one identity per Channel, so two identities can
 * never end up multiplexed over the same connection regardless of this
 * setting — 'simultaneous' only ever means "two separate connections are
 * both open," never "one connection claims two identities." Default
 * 'sequential' matches the safer recommendation (reduces, but — a relay
 * operator logging connect-time/IP over time can still correlate — does
 * NOT eliminate, the timing-correlation risk this file's own doc comment
 * already describes); a caller choosing 'simultaneous' should surface that
 * tradeoff to the user, not silently opt them in.
 */
export async function saveIncognitoIdentity(qu, { alias, fingerprint, keys, createdAt, connectionMode = 'sequential' }) {
  return qu.own.get(INCOGNITO_PREFIX).get(alias).put({ fingerprint, keys, createdAt, connectionMode }, { encryptFor: [qu.fingerprint] });
}

/**
 * Tombstones one persisted alias (`put(null)`, same "tombstone, not
 * physically erased" LWW semantics as `modules/profiles.js`'s
 * `deleteProfileAttr()`) — `loadIncognitoStore()`/`onIncognitoIdentitiesChange()`
 * both treat `null` as absent. Does NOT touch the incognito identity's own
 * `~<fp>` Space (whatever it published there, e.g. under a Space it joined,
 * is unaffected) — this only forgets the LOCAL/multi-device bookkeeping
 * entry that lets the owner find/re-enter it.
 */
export async function removeIncognitoIdentity(qu, alias) {
  return qu.own.get(INCOGNITO_PREFIX).get(alias).put(null);
}

/**
 * One-shot read of every currently-persisted (non-tombstoned) alias, in the
 * EXACT SAME plain-object shape (`{ [alias]: { fingerprint, keys, createdAt } }`)
 * `listIncognitoIdentities()`/`getIncognitoIdentity()`/`deleteIncognitoIdentity()`
 * above already operate on — so those three pure functions work UNCHANGED
 * on top of this persisted store, same as on a caller-managed plain object.
 * Filters by verified `q.writer` (not just path), same defense-in-depth
 * stance as `listProfileAttrs()` — a stray write under this identity's own
 * `incognito/` subtree is structurally impossible under the normal ACL
 * (only the owner can write into their own User-Space), but never assumed
 * away here regardless.
 */
export async function loadIncognitoStore(qu) {
  const prefix = `${qu.own.id}/${INCOGNITO_PREFIX}/`;
  const rows = await qu.session.query(`${prefix}**`);
  const store = {};
  for (const q of rows) {
    if (q.writer !== qu.fingerprint) continue;
    const alias = q.id.slice(prefix.length);
    if (q.value == null) continue; // tombstoned
    store[alias] = q.value;
  }
  return store;
}

/**
 * Live subscription to the persisted alias list — `callback(q)` fires with
 * the raw QuBit for every current AND future add/edit/remove
 * (`q.value === null` for a removal, same convention as
 * `onProfileAttrsChange()`), `q.id`'s last path segment is the alias.
 */
export function onIncognitoIdentitiesChange(qu, callback, opts) {
  return qu.own.get(INCOGNITO_PREFIX).map(callback, opts);
}

/**
 * `qu.use(createIncognitoPlugin())` — attaches `qu.createIncognitoIdentity()`
 * (the standalone, store-agnostic generator above, unchanged) plus the
 * persisted-store sugar (`qu.saveIncognitoIdentity()`/
 * `qu.loadIncognitoStore()`/`qu.removeIncognitoIdentity()`/
 * `qu.onIncognitoIdentitiesChange()`) and `qu.enterIncognito()`, mirroring
 * every other `create*Plugin()` in this directory.
 */
export function createIncognitoPlugin() {
  return {
    install(qu) {
      qu.createIncognitoIdentity = (alias) => createIncognitoIdentity(alias);
      qu.saveIncognitoIdentity = (entry) => saveIncognitoIdentity(qu, entry);
      qu.removeIncognitoIdentity = (alias) => removeIncognitoIdentity(qu, alias);
      qu.loadIncognitoStore = () => loadIncognitoStore(qu);
      qu.onIncognitoIdentitiesChange = (callback, opts) => onIncognitoIdentitiesChange(qu, callback, opts);
      qu.enterIncognito = (storedKeys, opts) => enterIncognito(qu, storedKeys, opts);
    },
  };
}
