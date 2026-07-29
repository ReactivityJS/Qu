import { star, unstar, listStarred, onStarredChange } from './starred.js';

// A per-identity "apps I use most" list — shell/qu-nav-dropdown.mjs's own
// Favoriten section is the real, permanent consumer (see that file's own
// doc for why the dropdown now needs `.qu` at all). A favorited app is
// really just a STARRED APP — this module is a thin wrapper over
// modules/starred.js's generic mechanism (the exact same shape
// modules/contacts.js's starred PEOPLE need), translating this domain's
// own vocabulary (a plain server/service-registry.mjs catalog id) onto it.
//
// Deliberately PLAIN, not `encryptFor: [qu.fingerprint]` like
// modules/contacts.js's contact list — which apps you star is low-
// sensitivity UI preference, not the "who do I know" social-graph
// information contacts.js protects; a relay operator (or anyone who can
// read this identity's Space at all) seeing "this fingerprint favorited
// chat and forum" reveals nothing a directory-visible profile doesn't
// already imply. Keeping it plain also means a future "show what's
// popular across this deployment" feature (not built here) could work
// off aggregate reads without needing every identity to opt in twice.
const FAVORITES_PREFIX = 'favorite-apps';

/**
 * Favorites (or re-favorites, a harmless idempotent no-op) one app —
 * `appId` is a plain server/service-registry.mjs catalog id (`'chat'`,
 * `'hello-world'`, …), not a fingerprint, so there is no format to
 * validate beyond "non-empty" the way `addContact()` validates a
 * fingerprint.
 */
export async function addFavorite(qu, appId) {
  return star(qu, FAVORITES_PREFIX, appId, { data: { appId } });
}

/** Tombstones one favorite (`put(null)`) — `listFavorites()`/`onFavoritesChange()` both treat it as absent. Removing an appId that was never favorited is a harmless no-op, same "no special-cased absence" stance as `modules/spaces.js`'s `removeFromRole()`. */
export async function removeFavorite(qu, appId) {
  return unstar(qu, FAVORITES_PREFIX, appId);
}

/**
 * One-shot read of every currently-favorited (non-tombstoned) appId, as a
 * plain `string[]` (unlike `listContacts()`'s richer objects, there is no
 * extra per-favorite metadata a caller needs beyond "is this one starred"
 * today).
 */
export async function listFavorites(qu) {
  return (await listStarred(qu, FAVORITES_PREFIX)).map((item) => item.appId);
}

/**
 * Live subscription to the favorites list — `callback(q)` fires with the
 * raw QuBit for every current AND future add/remove (`q.value === null`
 * for a removal, same convention as `onContactsChange()`), `q.id`'s last
 * path segment is the favorited appId.
 */
export function onFavoritesChange(qu, callback, opts) {
  return onStarredChange(qu, FAVORITES_PREFIX, callback, opts);
}

/**
 * `qu.use(createFavoritesPlugin())` — attaches `qu.addFavorite()`/
 * `qu.removeFavorite()`/`qu.listFavorites()`/`qu.onFavoritesChange()`
 * sugar bound to this Qu instance, mirroring every other `create*Plugin()`
 * in this directory (`createContactsPlugin()`, `createProfilesPlugin()`).
 */
export function createFavoritesPlugin() {
  return {
    install(qu) {
      qu.addFavorite = (appId) => addFavorite(qu, appId);
      qu.removeFavorite = (appId) => removeFavorite(qu, appId);
      qu.listFavorites = () => listFavorites(qu);
      qu.onFavoritesChange = (callback, opts) => onFavoritesChange(qu, callback, opts);
    },
  };
}
