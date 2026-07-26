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
 *
 * READING the manifest itself is likewise special-cased for admins on a
 * generic Space: an admin can always read it, even if `readers` doesn't
 * (yet, or anymore) list them — otherwise setting `readers` to something
 * that excludes yourself (e.g. going fully private, `readers: []`) would
 * lock even an admin out of the one document they need to be able to read
 * in order to fix it (addToRole()/removeFromRole() below read-then-patch
 * the manifest through this same ACL-checked path). Ordinary CONTENT under
 * the Space is unaffected — `readers` still governs it exactly as written,
 * no admin exception there. Same "cannot be locked out of your own
 * administration" precedent as the User-Space owner guarantee just above,
 * scoped narrowly to the manifest document only.
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
    const contentReaders = m.readers ?? ['*'];
    return {
      writers: isManifestWrite ? (m.admins ?? []) : (m.writers ?? []),
      readers: isManifestWrite ? [...new Set([...contentReaders, ...(m.admins ?? [])])] : contentReaders,
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

const MANIFEST_ROLES = ['writers', 'readers', 'admins'];

/**
 * Shared by addToRole()/removeFromRole() below — reads the current
 * manifest, hands its `role` array to `mutate()`, and writes the patched
 * manifest back. Any manifest field NOT touched here (the other two roles,
 * `createdAt`) survives unchanged, same discipline as every other
 * `{ ...manifest, x }`-style patch in this codebase (e.g. examples/
 * todo-lib.mjs's grantWriteAccess()). Enforcement that only an Admin may
 * actually land this write is NOT duplicated here — writing to `spaceId`
 * itself already requires being listed in `admins` per
 * createSpaceACLResolver() above, so an unauthorized call fails exactly
 * the same way any other unauthorized manifest write would.
 *
 * KNOWN, accepted race (read-then-write, no compare-and-swap): two
 * concurrent calls — e.g. two admins each independently adding a different
 * fingerprint — both read the same manifest snapshot and each publish
 * based on it; whichever publish() lands second (by ts, see core/clock.js)
 * wins outright and the other's role change is silently lost, not merged.
 * Same class of trade-off as createSpaceACLResolver's documented
 * first-write-wins bootstrap race, just on an ongoing edit instead of
 * Space creation — a caller that needs both changes to survive must
 * re-read the manifest and retry, this function does not do so itself.
 */
async function patchManifestRole(session, spaceId, role, mutate) {
  if (!MANIFEST_ROLES.includes(role)) {
    throw new Error(`[Spaces] Ungültige Rolle "${role}" (erwartet "writers", "readers" oder "admins").`);
  }
  const manifestQ = await session.get(spaceId);
  const manifest = manifestQ?.value;
  if (!manifest) throw new Error(`[Spaces] Kein Manifest unter "${spaceId}" — Space existiert (für diesen Client) noch nicht/noch nicht gesynct.`);
  return session.publish(spaceId, { ...manifest, [role]: mutate(manifest[role] ?? []) });
}

/**
 * Add a fingerprint (or `'*'`, "everyone") to one of a Space's three roles.
 * ONE generic function instead of six (add/removeWriter, add/removeReader,
 * add/removeAdmin) — the manifest shape is identical across all three, and
 * every CMS/ToDo/Forum-style app built on `createSpacesPlugin()` needs the
 * exact same "add this fingerprint to that role" operation, whichever role
 * it happens to be (see examples/space-app-lib.mjs, which used to
 * reimplement this for `writers` alone before this existed). Idempotent —
 * adding an already-present fingerprint is a no-op write, not an error.
 */
export async function addToRole(session, spaceId, role, fingerprint) {
  return patchManifestRole(session, spaceId, role, (list) => (list.includes(fingerprint) ? list : [...list, fingerprint]));
}

/**
 * The inverse of addToRole() — removes a fingerprint from one role, other
 * roles/fields untouched. Removing a fingerprint that isn't present is a
 * no-op write, not an error (same "no special-cased absence" stance as
 * `Array.prototype.filter()` itself). No protection here against removing
 * the space's only remaining admin, or an admin removing themselves —
 * same deliberately-unguarded stance as the rest of this module (see
 * createSpaceACLResolver's bootstrap-race note above): a Space an admin
 * has locked everyone (including themselves) out of stays readable per
 * its `readers`, just no longer administrable by anyone — a real but
 * self-inflicted outcome, not one this function silently prevents.
 */
export async function removeFromRole(session, spaceId, role, fingerprint) {
  return patchManifestRole(session, spaceId, role, (list) => list.filter((fp) => fp !== fingerprint));
}

/**
 * Same manifest-bootstrap as createSpace(), but for a caller-CHOSEN id
 * instead of a random one — for the "one well-known Space per app" case
 * (an App-Space), where there's exactly one id, known upfront, that an app
 * always uses, rather than "many independently created rooms" each needing
 * their own fresh, unpredictable id. Same first-write-wins bootstrap race
 * as createSpace() (see createSpaceACLResolver above) applies identically —
 * only now it's the app's own chosen id racing, not a fresh random one.
 */
export async function createSpaceAt(session, id, opts) {
  await session.publish(id, buildManifest(session.fingerprint, opts));
  return id;
}

/**
 * `qu.use(createSpacesPlugin())` — swaps the Core's identity-only default
 * ACL for this manifest-aware one (via `qu.setACLResolver()`, affecting
 * every Qu instance sharing this Runtime, not just the caller) and attaches
 * `qu.createSpace(opts)`/`qu.createSpaceAt(id, opts)` plus
 * `qu.addToRole(spaceId, role, fingerprint)`/`qu.removeFromRole(spaceId,
 * role, fingerprint)` for editing an EXISTING manifest's `writers`/
 * `readers`/`admins` afterwards (see addToRole()/removeFromRole() below).
 * Without this, `createChatRoom()`/any multi-writer Space is unwritable —
 * the Core default only ever grants `~<own fingerprint>`.
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
 * `createSpace(session, opts)` below. `qu.createSpaceAt(id, opts)` is the
 * same synchronous shape for a caller-chosen id (see createSpaceAt() above)
 * — for an App-Space, where the id is fixed and known upfront rather than
 * freshly generated.
 */
/**
 * Shared by `qu.createSpace()`/`qu.createSpaceAt()` below — both are the
 * same "make a node at `id`, fire off its manifest write, expose that write
 * as `.ready`" recipe, differing only in whether `id` is freshly random or
 * caller-chosen. `fnName` is only for the error/log messages, so a failure
 * still points at the actual call the caller made.
 */
function makeSpace(qu, id, opts, fnName) {
  if (qu.isGuest) throw new Error(`[Spaces] Guest-Sessions haben kein Schreibrecht (versucht: ${fnName}). Mit Qu.create({ identity }) eine echte Identität verwenden.`);
  const space = qu.get(id);
  space.ready = qu.session.publish(id, buildManifest(qu.fingerprint, opts));
  space.ready.catch((e) => console.error(`[Spaces] ${fnName}(): manifest write for ${id} failed:`, e));
  return space;
}

export function createSpacesPlugin() {
  return {
    install(qu) {
      qu.setACLResolver(createSpaceACLResolver(qu.runtime));
      qu.createSpace = (opts) => makeSpace(qu, randomSpaceId(), opts, 'createSpace');
      qu.createSpaceAt = (id, opts) => makeSpace(qu, id, opts, 'createSpaceAt');
      // qu-gebundene Bequemlichkeit über addToRole()/removeFromRole() (siehe
      // deren Doku oben) — `session` muss so nicht an jeder Aufrufstelle
      // durchgereicht werden, derselbe Komfort wie qu.createSpace(opts)
      // gegenüber dem eigenständigen createSpace(session, opts).
      qu.addToRole = (spaceId, role, fingerprint) => addToRole(qu.session, spaceId, role, fingerprint);
      qu.removeFromRole = (spaceId, role, fingerprint) => removeFromRole(qu.session, spaceId, role, fingerprint);
    },
  };
}
