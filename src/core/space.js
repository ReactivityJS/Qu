// A Space is the unit ACLs are bound to (see modules/spaces.js for the
// manifest-based resolver). Two kinds, same shape everywhere else:
//   "~<fingerprint>"  — User-Space, name IS the owner's identity
//   "<uuid>"           — generic Space, no implicit owner
//
// A QuBit's id is always "<SpaceId>" (the Space's own manifest) or
// "<SpaceId>/<subpath>". Nothing about Storage-Mounts (see core/store.js)
// changes because of this — those configure *where bytes live*, this
// configures *who may write/read*. A single physical mount can hold many
// Spaces; a Space's data could even be split across several mounts by
// subpath if an app wanted that. The two concepts are intentionally
// orthogonal.

export function spaceIdOf(id) {
  const clean = id.startsWith('/') ? id.slice(1) : id;
  const i = clean.indexOf('/');
  return i === -1 ? clean : clean.slice(0, i);
}

export function isUserSpaceId(spaceId) {
  return spaceId.startsWith('~');
}

export function userSpaceId(fingerprint) {
  return `~${fingerprint}`;
}

export function fingerprintOfUserSpace(spaceId) {
  return isUserSpaceId(spaceId) ? spaceId.slice(1) : null;
}

export function randomSpaceId() {
  return crypto.randomUUID();
}

// Reserved leaves under every User-Space: `pub` (signing public key, JWK),
// `epub` (ECDH/encryption public key, JWK), `alias` (display nickname).
// Structurally always publicly READABLE (see modules/spaces.js's
// createSpaceACLResolver — a restricted `readers` list on your own
// User-Space manifest never hides these three, the same "cannot be locked
// out of your own identity root" precedent already applied to `writers`)
// and never auto-encrypted (see core/session.js's default-recipients
// logic) — encrypting your own public key would make it undiscoverable to
// exactly the peers who need it to decrypt anything from you at all.
// WRITE access is unaffected by this: only the owner (or an explicitly
// manifest-authorized co-writer) can ever publish under `~<fp>/**`.
export const RESERVED_PROFILE_PATHS = ['pub', 'epub', 'alias'];

export function isReservedProfilePath(id) {
  const clean = id.startsWith('/') ? id.slice(1) : id;
  const spaceId = spaceIdOf(clean);
  if (!isUserSpaceId(spaceId)) return false;
  return RESERVED_PROFILE_PATHS.includes(clean.slice(spaceId.length + 1));
}
