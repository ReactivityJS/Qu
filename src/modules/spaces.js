import { spaceIdOf, isUserSpaceId, fingerprintOfUserSpace, randomSpaceId } from '../core/space.js';

/**
 * The Spaces plugin: replaces the Core's zero-config default ACL
 * (core/identity-acl.js — "write only under your own `~<fingerprint>`,
 * nothing else") with manifest-aware resolution. Without this plugin
 * installed, `qu.createSpace()` does not exist and no generic (non-User)
 * Space is ever writable, at all — see qu.js's `setACLResolver()`.
 *
 * ACLs are bound to Spaces, not to individual paths or messages — one
 * manifest QuBit per Space, stored exactly at the Space's own root id.
 * This is a `getACL(id)` implementation, so it plugs directly into the
 * existing createACLPlugin/filterForReader without either of those needing
 * to know Spaces exist.
 *
 * User-Space (`~<fingerprint>`): the owner is always a writer/admin, with
 * or without a manifest, and no manifest content can remove that — you
 * cannot be locked out of your own identity root. A manifest can only ADD
 * writers beyond the owner — the one behavior this plugin adds on top of
 * the Core default, for User-Spaces specifically.
 *
 * Generic Space (uuid): no implicit owner. Bootstrap rule: before any
 * manifest exists, anyone may write (including the first manifest itself —
 * first-write-wins). Once a manifest exists, it governs. This is a known,
 * accepted v1 simplification (a race for the very first write is possible);
 * revisiting it (e.g. reserve-before-write) is a later, backward-compatible
 * addition, not an architectural change.
 *
 * Writing the manifest itself (id === spaceId) requires being listed in
 * `admins`, not merely `writers` — so a Space's regular writers can't
 * silently reassign its own permissions.
 */
export function createSpaceACLResolver(runtime) {
  return async function getACL(id) {
    const spaceId = spaceIdOf(id);
    const manifestQ = await runtime.get(spaceId);
    const m = manifestQ?.value ?? null;
    const isManifestWrite = id === spaceId;

    if (isUserSpaceId(spaceId)) {
      const owner = fingerprintOfUserSpace(spaceId);
      const writers = new Set(m?.writers ?? []);
      const admins = new Set(m?.admins ?? []);
      writers.add(owner);
      admins.add(owner); // structural guarantee: never lockable
      return {
        writers: isManifestWrite ? [...admins] : [...writers],
        readers: m?.readers ?? ['*'],
      };
    }

    if (!m) return { writers: ['*'], readers: ['*'] }; // bootstrap: no manifest yet
    return {
      writers: isManifestWrite ? (m.admins ?? []) : (m.writers ?? []),
      readers: m.readers ?? ['*'],
    };
  };
}

/** Convenience: create a new generic Space with an explicit manifest. Returns the new SpaceId. */
export async function createSpace(session, { writers = [], readers = ['*'], admins } = {}) {
  const spaceId = randomSpaceId();
  const adminList = admins ?? (session.fingerprint ? [session.fingerprint] : []);
  await session.publish(spaceId, { admins: adminList, writers, readers, createdAt: Date.now() });
  return spaceId;
}

/**
 * `qu.use(createSpacesPlugin())` — swaps the Core's identity-only default
 * ACL for this manifest-aware one (via `qu.setACLResolver()`, affecting
 * every Qu instance sharing this Runtime, not just the caller) and attaches
 * `qu.createSpace(opts)`. Without this, `createChatRoom()`/any multi-writer
 * Space is unwritable — the Core default only ever grants `~<own fingerprint>`.
 *
 * `qu.createSpace(opts)` returns a `QuSpace` (via `qu.space(spaceId)`), not
 * a raw id string — so the manifest write and the room's first real write
 * can both go through the same handle. Still safe to use exactly like the
 * old raw SpaceId anywhere a string was expected (`${room}/msg`,
 * `JSON.stringify({ room })`, or passing it straight into
 * `qu.publish(room, ...)`) — see core/space-handle.js.
 */
export function createSpacesPlugin() {
  return {
    install(qu) {
      qu.setACLResolver(createSpaceACLResolver(qu.runtime));
      qu.createSpace = async (opts) => {
        if (qu.isGuest) throw new Error('[Spaces] Guest-Sessions haben kein Schreibrecht (versucht: createSpace). Mit Qu.create({ identity }) eine echte Identität verwenden.');
        const spaceId = await createSpace(qu.session, opts);
        return qu.space(spaceId);
      };
    },
  };
}
