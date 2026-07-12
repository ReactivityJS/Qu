import { spaceIdOf, isUserSpaceId, fingerprintOfUserSpace, randomSpaceId, isReservedProfilePath } from '../core/space.js';

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
      // Same "cannot be locked out" precedent, applied to reads: pub/epub/alias
      // (core/space.js's RESERVED_PROFILE_PATHS) must stay discoverable by
      // everyone even if this owner restricts their Space's `readers`
      // elsewhere — otherwise nobody could ever encrypt a message *to* them.
      const readers = isReservedProfilePath(id) ? ['*'] : (m?.readers ?? ['*']);
      return {
        writers: isManifestWrite ? [...admins] : [...writers],
        readers,
      };
    }

    if (!m) return { writers: ['*'], readers: ['*'] }; // bootstrap: no manifest yet
    return {
      writers: isManifestWrite ? (m.admins ?? []) : (m.writers ?? []),
      readers: m.readers ?? ['*'],
    };
  };
}

function buildManifest(fingerprint, { writers = [], readers = ['*'], admins } = {}) {
  return { admins: admins ?? (fingerprint ? [fingerprint] : []), writers, readers, createdAt: Date.now() };
}

/** Convenience: create a new generic Space with an explicit manifest. Returns the new SpaceId, only once the manifest write has actually landed. */
export async function createSpace(session, opts) {
  const spaceId = randomSpaceId();
  await session.publish(spaceId, buildManifest(session.fingerprint, opts));
  return spaceId;
}

/**
 * `qu.use(createSpacesPlugin())` — swaps the Core's identity-only default
 * ACL for this manifest-aware one (via `qu.setACLResolver()`, affecting
 * every Qu instance sharing this Runtime, not just the caller) and attaches
 * `qu.createSpace(opts)`. Without this, `createChatRoom()`/any multi-writer
 * Space is unwritable — the Core default only ever grants `~<own fingerprint>`.
 *
 * `qu.createSpace(opts)` is SYNCHRONOUS — like `qu.get(id)`, it returns the
 * new Space's `QuSpace` immediately, no `await` needed to keep navigating
 * (`qu.createSpace(opts).get('msg1').put(...)`). This is not just a style
 * choice: `QuSpace` is thenable (see core/space-handle.js), and a Promise
 * that resolves WITH a thenable is unconditionally "chased" by the Promise
 * spec — `await` on the OUTER promise would silently unwrap the whole way
 * through to the manifest's QuBit, not the node, if this were `async`. Same
 * rule as everywhere else in this API: no `await` navigates, `await` reads.
 *
 * The manifest write itself is fire-and-forget from here (logged, not
 * thrown, on failure) — this is the same accepted bootstrap race already
 * documented on `createSpaceACLResolver` above (no manifest yet -> anyone
 * may write), just a slightly wider window. Importantly, `await`ing the
 * returned node (a plain READ) does NOT reliably wait for that write to
 * land — Runtime has no per-id read/write ordering, so a read started right
 * after can race ahead of the write's own verify+sign+ingest pipeline and
 * see nothing yet. A caller that genuinely needs the manifest confirmed
 * durable before proceeding (e.g. handing the id to someone else who'll
 * immediately try to use it, or writing again to the SAME id right after)
 * has two reliable options: `await space.ready` (the actual write's own
 * Promise, exposed on the returned node) or the standalone, awaitable
 * `createSpace(session, opts)` below.
 */
export function createSpacesPlugin() {
  return {
    install(qu) {
      qu.setACLResolver(createSpaceACLResolver(qu.runtime));
      qu.createSpace = (opts) => {
        if (qu.isGuest) throw new Error('[Spaces] Guest-Sessions haben kein Schreibrecht (versucht: createSpace). Mit Qu.create({ identity }) eine echte Identität verwenden.');
        const spaceId = randomSpaceId();
        const space = qu.get(spaceId);
        space.ready = qu.session.publish(spaceId, buildManifest(qu.fingerprint, opts));
        space.ready.catch((e) => console.error(`[Spaces] createSpace(): manifest write for ${spaceId} failed:`, e));
        return space;
      };
    },
  };
}
