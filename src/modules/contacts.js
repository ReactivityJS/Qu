import { isValidFingerprint } from '../core/identity.js';

// A private "people I know" list — distinct from modules/profiles.js's
// PUBLIC, opt-in directory (`DIRECTORY_ID`): a contact entry is never
// visible to anyone but its owner, encrypted-to-self exactly like
// modules/incognito-identity.js's persisted alias list (same
// `encryptFor: [qu.fingerprint]` path, no new crypto here either).
//
// One QuBit per contact, keyed by the CONTACT's own fingerprint (not a
// `set()` collection) — only the owner ever writes into their own
// `contacts/` subtree, so there's no multi-writer collision to guard
// against, and keying by fingerprint makes "add the same contact twice"
// naturally idempotent (LWW overwrite, same entry) and "remove" a plain
// `put(null)` tombstone — same convention `modules/profiles.js`'s
// `deleteProfileAttr()` and `modules/incognito-identity.js`'s
// `removeIncognitoIdentity()` already use.
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
  return qu.own.get(CONTACTS_PREFIX).get(contactFingerprint).put({ fingerprint: contactFingerprint, alias, addedAt: Date.now() }, { encryptFor: [qu.fingerprint] });
}

/** Tombstones one contact (`put(null)`) — `listContacts()`/`onContactsChange()` both treat it as absent. Removing an unknown fingerprint is a harmless no-op, same "no special-cased absence" stance as `modules/spaces.js`'s `removeFromRole()`. */
export async function removeContact(qu, contactFingerprint) {
  return qu.own.get(CONTACTS_PREFIX).get(contactFingerprint).put(null);
}

/**
 * One-shot read of every currently-known (non-tombstoned) contact, as
 * `{fingerprint, alias, addedAt}[]`. Filters by verified `q.writer` (not
 * just path), same defense-in-depth stance as `listProfileAttrs()`/
 * `loadIncognitoStore()` — a stray write under this identity's own
 * `contacts/` subtree is structurally impossible under the normal ACL, but
 * never assumed away here regardless.
 */
export async function listContacts(qu) {
  const prefix = `${qu.own.id}/${CONTACTS_PREFIX}/`;
  const rows = await qu.session.query(`${prefix}**`);
  const contacts = [];
  for (const q of rows) {
    if (q.writer !== qu.fingerprint) continue;
    if (q.value == null) continue; // tombstoned
    contacts.push(q.value);
  }
  return contacts;
}

/**
 * Live subscription to the contact list — `callback(q)` fires with the raw
 * QuBit for every current AND future add/edit/remove (`q.value === null`
 * for a removal, same convention as `onProfileAttrsChange()`/
 * `onIncognitoIdentitiesChange()`), `q.id`'s last path segment is the
 * contact's fingerprint.
 */
export function onContactsChange(qu, callback, opts) {
  return qu.own.get(CONTACTS_PREFIX).map(callback, opts);
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
