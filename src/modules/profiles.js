// Identity (see modules/spaces.js's User-Space, Qu#publishProfile()/
// readProfile()) is the one thing every Qu app already shares — one
// profile, one alias, one avatar, meant to be reused instead of each app
// inventing its own contact/user model. This module builds two more
// identity-centric, still app-agnostic pieces on top of that:
//
// 1. Custom profile attributes — arbitrary additional fields beyond
//    alias/avatar (a bio, a link, whatever a given app needs), plain or
//    encrypted, stored under `~<fp>/attrs/<key>` — one leaf QuBit per
//    field, the same "each field its own LWW register" discipline as
//    everywhere else in this codebase (so two apps editing different
//    attributes of the same identity never collide on one value).
//
// 2. A global, OPT-IN identity directory — a single well-known Space
//    (DIRECTORY_ID) that makes an identity DISCOVERABLE without already
//    knowing its fingerprint, the one thing a per-identity User-Space
//    alone can never provide (nothing points AT it, by design — see
//    core/identity.js: a fingerprint is not searchable on its own).
//    Membership is self-published (each identity writes only its OWN
//    entry, keyed by its own fingerprint) and OFF by default — an
//    identity stays invisible in the directory until it explicitly calls
//    setDirectoryVisible(true). Same "path is addressing, not trust"
//    discipline as modules/chat.js's message ids: every reader keys off
//    the verified QuBit `writer`, never the path segment, since the
//    Space's `writers: ['*']` lets anyone technically write anywhere
//    under it — a forged entry at someone else's expected path is still
//    only ever attributed to whoever actually signed it.
//
// Deliberately NOT chat/people-app-specific: no rendering, no local
// persistence, no app-chosen UI copy — see examples/people/app.mjs for
// the app that turns this into screens.

import { userSpaceId } from '../core/space.js';

const ATTR_PREFIX = 'attrs';

/**
 * Sets one custom profile attribute on the caller's own identity.
 * `encryptFor`, if given, restricts who can decrypt this specific field
 * (same `encryptFor` mechanism as everywhere else — sendMessage(),
 * publishFile()); omitted, the attribute is plain, readable by anyone who
 * can read the owner's Space at all (default: everyone, same as
 * alias/avatar — see core/space.js's RESERVED_PROFILE_PATHS doc for why
 * `attrs/*` is deliberately NOT in that list: unlike alias/epub, a custom
 * attribute has no structural reason to stay readable if the owner
 * restricts their own Space's `readers`).
 */
export async function setProfileAttr(qu, key, value, { encryptFor } = {}) {
  return qu.own.get(ATTR_PREFIX).get(key).put(value, encryptFor ? { encryptFor } : undefined);
}

/** Reads one custom attribute of `fingerprint`'s identity — `null` if never set, deleted, or (for an encrypted attribute) the caller isn't an addressed recipient. */
export async function getProfileAttr(qu, fingerprint, key) {
  const q = await qu.get(`${userSpaceId(fingerprint)}/${ATTR_PREFIX}/${key}`);
  return q?.value ?? null;
}

/** Deletes one of the caller's own custom attributes — a `put(null)`, same "tombstone, not physically erased" LWW semantics as any other QuBit; listProfileAttrs()/getProfileAttr() both treat `null` as absent. */
export async function deleteProfileAttr(qu, key) {
  return qu.own.get(ATTR_PREFIX).get(key).put(null);
}

/**
 * All of `fingerprint`'s current (non-deleted) custom attributes as a
 * plain `{ key: value }` object. Filters by the QuBit's verified `writer`,
 * not by path — see file doc — so a stray write from someone else under
 * this identity's `attrs/` subtree (impossible under the normal ACL, since
 * only the owner/an authorized co-writer can write into a User-Space, but
 * never assumed away here regardless) can never masquerade as this
 * identity's own attribute.
 */
export async function listProfileAttrs(qu, fingerprint) {
  const prefix = `${userSpaceId(fingerprint)}/${ATTR_PREFIX}/`;
  const rows = await qu.session.query(`${userSpaceId(fingerprint)}/${ATTR_PREFIX}/**`);
  const attrs = {};
  for (const q of rows) {
    if (q.writer !== fingerprint) continue;
    if (q.value === null || q.value === undefined) continue;
    attrs[q.id.slice(prefix.length)] = q.value;
  }
  return attrs;
}

/** Live subscription to `fingerprint`'s custom-attribute changes (add/edit/delete, `q.value === null` for the latter). */
export function onProfileAttrsChange(qu, fingerprint, callback, opts) {
  return qu.get(userSpaceId(fingerprint)).get(ATTR_PREFIX).map(callback, opts);
}

// --- Global identity directory ---

/** The one well-known "App-Space" every identity that opts in publishes its own directory entry into — see modules/spaces.js's createSpaceAt() doc for this "one fixed id per app" shape. */
export const DIRECTORY_ID = 'qu-directory';

/** Bootstraps the directory Space if it doesn't exist yet — `writers: ['*']` (anyone may publish their OWN entry, see file doc), `readers: ['*']` (the whole point is to be publicly discoverable). A no-op once any identity has already done this once. */
export async function ensureDirectory(qu) {
  const manifest = await qu.get(DIRECTORY_ID);
  if (manifest) return qu.get(DIRECTORY_ID);
  const space = qu.createSpaceAt(DIRECTORY_ID, { writers: ['*'], readers: ['*'], admins: [qu.fingerprint] });
  await space.ready.catch((e) => console.error('[Profiles] ensureDirectory(): manifest write failed:', e));
  return space;
}

/**
 * Publishes (or retracts) the caller's own directory entry — `visible`
 * defaults to `false` deliberately explicit, never silently "on": an
 * identity that never calls this at all has no entry, and one that calls
 * it with `false` has an entry that says so, both cases indistinguishable
 * to listDirectory() below (either way, not listed) but the latter also
 * lets a UI show "you are currently hidden" rather than "you were never
 * asked". `entries/<own fp>` is a fixed key — toggling visibility again
 * overwrites the same slot, no growing history of past on/off states.
 */
export async function setDirectoryVisible(qu, visible) {
  await ensureDirectory(qu);
  return qu.get(DIRECTORY_ID).get('entries').get(qu.fingerprint).put({ visible: !!visible });
}

/**
 * Every identity currently visible in the directory, as
 * `{ fingerprint }[]` — alias/avatar are deliberately NOT duplicated here
 * (single source of truth stays each identity's own Space, see
 * Qu#readProfile()); a caller renders the list by resolving each
 * fingerprint's profile separately, same as any other identity lookup in
 * this codebase. Deduplicated by the QuBit's verified `writer` (see file
 * doc), not by path, so a forged entry under someone else's expected key
 * can never inject a second, fake row for a real identity.
 */
export async function listDirectory(qu) {
  const rows = await qu.session.query(`${DIRECTORY_ID}/entries/**`);
  const visible = new Map();
  for (const q of rows) {
    if (!q.writer) continue;
    if (q.value?.visible) visible.set(q.writer, { fingerprint: q.writer });
    else visible.delete(q.writer);
  }
  return [...visible.values()];
}

/** Live subscription to directory changes (a new entry, a visibility flip in either direction). */
export function onDirectoryChange(qu, callback, opts) {
  return qu.get(DIRECTORY_ID).get('entries').map(callback, opts);
}

/**
 * `qu.use(createProfilesPlugin())` — attaches `qu.setProfileAttr()`/etc.
 * sugar bound to this Qu instance, mirroring every other
 * `createXxxPlugin()` in modules/. Requires createSpacesPlugin() to
 * already be installed (ensureDirectory() uses `qu.createSpaceAt`).
 */
export function createProfilesPlugin() {
  return {
    install(qu) {
      qu.setProfileAttr = (key, value, opts) => setProfileAttr(qu, key, value, opts);
      qu.getProfileAttr = (fingerprint, key) => getProfileAttr(qu, fingerprint, key);
      qu.deleteProfileAttr = (key) => deleteProfileAttr(qu, key);
      qu.listProfileAttrs = (fingerprint) => listProfileAttrs(qu, fingerprint);
      qu.onProfileAttrsChange = (fingerprint, callback, opts) => onProfileAttrsChange(qu, fingerprint, callback, opts);
      qu.ensureDirectory = () => ensureDirectory(qu);
      qu.setDirectoryVisible = (visible) => setDirectoryVisible(qu, visible);
      qu.listDirectory = () => listDirectory(qu);
      qu.onDirectoryChange = (callback, opts) => onDirectoryChange(qu, callback, opts);
    },
  };
}
