// Generic "I marked this X" primitive — one QuBit per starred item, keyed
// by the item's own id under the OWNER's own Space, LWW tombstone via
// `put(null)` for removal. The exact shape modules/contacts.js (starred
// PEOPLE, encrypted-to-self) and modules/favorites.js (starred APPS,
// plain) both independently needed — factored out once both were shipped
// and the duplication became obvious, rather than speculatively built
// ahead of a second real consumer (see this codebase's own "no
// abstraction before a second real use" convention). A future third kind
// — bookmarking a forum post or CMS page, say — reuses this directly:
// `star(qu, 'bookmarked-posts', postId)`, no new plumbing needed.
//
// Every existing caller's PUBLIC API (addContact/listContacts/…,
// addFavorite/listFavorites/…) is unchanged by this — contacts.js and
// favorites.js are now thin wrappers translating their own domain
// vocabulary (a fingerprint + optional alias; a plain appId string) onto
// this one shared mechanism, still writing to the exact same QuBit ids
// (`contacts/<fp>`, `favorite-apps/<id>`) as before this refactor.

/**
 * Stars (or re-stars, a harmless idempotent no-op) one item under
 * `prefix` — `data` is merged with an `addedAt` timestamp into the stored
 * value; `encryptFor`, if given, restricts who can decrypt it (omitted:
 * plain, readable by anyone who can read the owner's Space at all — see
 * modules/favorites.js's own doc for why favorited APPS choose that,
 * versus modules/contacts.js's `[qu.fingerprint]` for starred PEOPLE).
 */
export async function star(qu, prefix, itemId, { data = {}, encryptFor } = {}) {
  if (!itemId) throw new Error(`[Starred] star() requires a non-empty itemId (prefix "${prefix}"), got: ${JSON.stringify(itemId)}`);
  return qu.own.get(prefix).get(itemId).put({ ...data, addedAt: Date.now() }, encryptFor ? { encryptFor } : undefined);
}

/** Tombstones one starred item (`put(null)`) — `listStarred()`/`onStarredChange()` both treat it as absent. Unstarring an item that was never starred is a harmless no-op, same "no special-cased absence" stance as `modules/spaces.js`'s `removeFromRole()`. */
export async function unstar(qu, prefix, itemId) {
  return qu.own.get(prefix).get(itemId).put(null);
}

/**
 * One-shot read of every currently-starred (non-tombstoned) item under
 * `prefix`, as the raw stored `data` objects (each still carrying its own
 * `addedAt`). Filters by verified `q.writer` (not just path), same
 * defense-in-depth stance as `listProfileAttrs()` — a stray write under
 * this identity's own `<prefix>/` subtree is structurally impossible
 * under the normal ACL, but never assumed away here regardless.
 */
export async function listStarred(qu, prefix) {
  const p = `${qu.own.id}/${prefix}/`;
  const rows = await qu.session.query(`${p}**`);
  const items = [];
  for (const q of rows) {
    if (q.writer !== qu.fingerprint) continue;
    if (q.value == null) continue; // tombstoned
    items.push(q.value);
  }
  return items;
}

/**
 * Live subscription to the starred list under `prefix` — `callback(q)`
 * fires with the raw QuBit for every current AND future star/unstar
 * (`q.value === null` for a removal), `q.id`'s last path segment is the
 * item's own id. `.map()` defaults `initial: true` (core/space-handle.js)
 * — one call already delivers whatever is currently starred first, then
 * every future change, no separate one-shot `listStarred()` call needed
 * alongside it (see src/ui/theme.js's `onThemeChange()` for the same
 * single-call idiom).
 */
export function onStarredChange(qu, prefix, callback, opts) {
  return qu.own.get(prefix).map(callback, opts);
}
