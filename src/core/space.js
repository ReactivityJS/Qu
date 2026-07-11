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
