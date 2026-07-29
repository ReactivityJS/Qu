import { isValidFingerprint } from '../core/identity.js';
import { star, unstar, listStarred, onStarredChange } from './starred.js';

// A private "people I know" list — distinct from modules/profiles.js's
// PUBLIC, opt-in directory (`DIRECTORY_ID`): a contact entry is never
// visible to anyone but its owner, encrypted-to-self exactly like
// modules/incognito-identity.js's persisted alias list (same
// `encryptFor: [qu.fingerprint]` path, no new crypto here either).
//
// A contact is really just a STARRED PERSON — this module is a thin
// wrapper over modules/starred.js's generic "one QuBit per item, keyed by
// the item's own id, LWW tombstone via put(null)" mechanism (the exact
// same shape modules/favorites.js's starred APPS need), translating this
// domain's own vocabulary (a fingerprint + optional local `alias` label)
// onto it. Same storage id (`contacts/<fp>`) as before this was factored
// out — nothing else in this codebase needed to change.
const CONTACTS_PREFIX = 'contacts';

/**
 * Adds (or updates) one contact — `alias` is an OPTIONAL, purely local
 * label for the owner's own UI ("Mama", "Chef") and is never published
 * anywhere else; it has no relation to `Qu#publishProfile()`'s `alias`
 * (that one's a public display name for the CONTACT's own identity, not
 * something this module ever sets). Re-adding an already-known fingerprint
 * overwrites `alias`/refreshes nothing about `addedAt` — same "trust the
 * caller, LWW settles it" stance as `saveIncognitoIdentity()`.
 */
export async function addContact(qu, contactFingerprint, { alias } = {}) {
  if (!isValidFingerprint(contactFingerprint)) {
    throw new Error(`[Contacts] addContact() requires a valid fingerprint, got: "${contactFingerprint}"`);
  }
  return star(qu, CONTACTS_PREFIX, contactFingerprint, { data: { fingerprint: contactFingerprint, alias }, encryptFor: [qu.fingerprint] });
}

/** Tombstones one contact (`put(null)`) — `listContacts()`/`onContactsChange()` both treat it as absent. Removing an unknown fingerprint is a harmless no-op, same "no special-cased absence" stance as `modules/spaces.js`'s `removeFromRole()`. */
export async function removeContact(qu, contactFingerprint) {
  return unstar(qu, CONTACTS_PREFIX, contactFingerprint);
}

/**
 * One-shot read of every currently-known (non-tombstoned) contact, as
 * `{fingerprint, alias, addedAt}[]`. Filters by verified `q.writer` (not
 * just path), same defense-in-depth stance as `listProfileAttrs()`/
 * `loadIncognitoStore()` — a stray write under this identity's own
 * `contacts/` subtree is structurally impossible under the normal ACL, but
 * never assumed away here regardless (enforced by modules/starred.js's
 * shared `listStarred()`, not duplicated here).
 */
export async function listContacts(qu) {
  return listStarred(qu, CONTACTS_PREFIX);
}

/**
 * Live subscription to the contact list — `callback(q)` fires with the raw
 * QuBit for every current AND future add/edit/remove (`q.value === null`
 * for a removal, same convention as `onProfileAttrsChange()`/
 * `onIncognitoIdentitiesChange()`), `q.id`'s last path segment is the
 * contact's fingerprint.
 */
export function onContactsChange(qu, callback, opts) {
  return onStarredChange(qu, CONTACTS_PREFIX, callback, opts);
}

/**
 * `qu.use(createContactsPlugin())` — attaches `qu.addContact()`/
 * `qu.removeContact()`/`qu.listContacts()`/`qu.onContactsChange()` sugar
 * bound to this Qu instance, mirroring every other `create*Plugin()` in
 * this directory (`createProfilesPlugin()`, `createIncognitoPlugin()`).
 */
export function createContactsPlugin() {
  return {
    install(qu) {
      qu.addContact = (fingerprint, opts) => addContact(qu, fingerprint, opts);
      qu.removeContact = (fingerprint) => removeContact(qu, fingerprint);
      qu.listContacts = () => listContacts(qu);
      qu.onContactsChange = (callback, opts) => onContactsChange(qu, callback, opts);
    },
  };
}
