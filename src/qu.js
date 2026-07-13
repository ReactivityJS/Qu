import { QuRuntime } from './core/runtime.js';
import { QuStore } from './core/store.js';
import { QuSession } from './core/session.js';
import { QuIdentity } from './core/identity.js';
import { QuSpace } from './core/space-handle.js';
import { userSpaceId } from './core/space.js';
import { MemoryAdapter } from './adapters/memory.js';
import { createVerifyPlugin } from './core/verify.js';
import { createACLPlugin } from './core/acl.js';
import { createIdentityACL } from './core/identity-acl.js';

// Tracks which Runtime instances already have the default Verify+ACL
// middleware installed, so sharing one Runtime across several `Qu`
// instances (e.g. several users on one server process) never registers
// the same middleware twice — and holds the one mutable "which policy is
// currently in force" slot per Runtime, plus that Runtime's "default
// plugins" (see wireRuntime() below).
//
// The ACL *enforcement* middleware (core/acl.js's createACLPlugin) is
// registered on the Runtime exactly once, wrapping a stable indirection
// function that reads `resolver.current` on every call. That's what lets a
// plugin's `install(qu)` — which necessarily runs AFTER `Qu.create()` has
// already resolved and already registered the middleware — still change
// *which* policy gets consulted (e.g. the Spaces plugin swapping in
// manifest-aware resolution), without re-registering middleware or
// weakening the "Verify+ACL, no exceptions" guarantee: enforcement itself
// never becomes optional, only the policy it enforces is swappable.
const wiredRuntimes = new WeakMap(); // Runtime -> { resolver: { current: getACLFn }, defaultPlugins: Plugin[] | null }

function wireRuntime(runtime) {
  let wired = wiredRuntimes.get(runtime);
  if (!wired) {
    const resolver = { current: createIdentityACL() };
    runtime.use(createVerifyPlugin());
    runtime.use(createACLPlugin((id) => resolver.current(id)));
    wired = { resolver, defaultPlugins: null };
    wiredRuntimes.set(runtime, wired);
  }
  return wired;
}

function isQuIdentity(x) {
  return x && typeof x.sign === 'function' && typeof x.fingerprint === 'string';
}

function isBytesLike(value) {
  return value instanceof Uint8Array
    || (typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof File !== 'undefined' && value instanceof File);
}

/**
 * Default put() dispatcher — plain publish(), EXCEPT file-shaped values
 * (Uint8Array, or Blob/File in a browser), which throw instead of silently
 * writing raw bytes as an opaque value. `createFileHandlerPlugin()` replaces
 * this (via `setPutHandler()`) with one that chunks+manifests them instead.
 */
const defaultPutDispatch = (session, id, value, opts) => {
  if (isBytesLike(value)) {
    throw new Error(`[Qu] put() hat Datei-Bytes für "${id}" erhalten, aber kein FileHandler ist konfiguriert. qu.use(createFileHandlerPlugin({ fileStorage })) hinzufügen, oder rohe Bytes bewusst über qu.session.publish() schreiben.`);
  }
  return session.publish(id, value, opts);
};

/**
 * Default resolve() dispatcher — the identity function, no `key://`
 * following at all. `createReferenceHandlerPlugin()` replaces this (via
 * `setResolveHandler()`) with one based on `resolveKeyChain()`
 * (data/references.js) so put/set/on/map/await transparently chase
 * chained `key://` redirects.
 */
const defaultResolveDispatch = async (session, id) => id;

/**
 * Qu is the class most applications should actually instantiate — it wraps
 * Runtime + Store + Session behind a small set of instance methods, so a
 * caller doesn't need to assemble those pieces by hand for the common case.
 * QuRuntime/QuSession/etc. remain the underlying primitives (still directly
 * usable — `qu.runtime` is the escape hatch) for advanced composition.
 *
 * Data access is five GunDB-inspired verbs, all reached through `qu.get(id)`
 * (a `QuSpace` — see core/space-handle.js for the full picture):
 *   qu.get(id)                a node bound to `id` — navigate further with
 *                             `.get(subpath)`, no I/O until you await it or
 *                             call put/set/on/map.
 *   qu.own                    `qu.get(qu.userSpaceId)` — your own Space,
 *                             always writable without any plugin (see
 *                             core/identity-acl.js's structural default).
 *   await qu.get(id)          reads the QuBit at `id`.
 *   qu.get(id).put(v, opts)    writes at `id` (LWW) — auto-detects
 *                             Uint8Array/Blob as a file if a FileHandler is
 *                             configured (see setPutHandler()).
 *   qu.get(id).set(v, opts)    collision-safe write into a shared
 *                             collection at `id` (many independent
 *                             writers — chat messages, comments).
 *   qu.get(id).on(cb, opts)    live subscription to `id`'s own value.
 *   qu.get(id).map(cb, opts)   live subscription to `id`'s children.
 *
 * Qu itself only knows Identity/Session/the five verbs above, and one
 * structural ACL fact: you may always write under `~<your fingerprint>`,
 * nothing else (see core/identity-acl.js — this costs nothing, needs no
 * manifest or Storage round-trip, and follows directly from `fingerprint =
 * hash(pubKey)`, so it's a property of Identity, not a policy choice).
 * Everything else — generic multi-writer Spaces, Files, References,
 * Replication, WebRTC, Chat — is a plugin, installed via `use()`.
 * `qu.createSpace()` in particular does not exist until
 * `qu.use(createSpacesPlugin())` — see modules/spaces.js. `src/presets.js`
 * bundles common plugin combinations (`QU_PRESETS.spaces`, `.network`).
 *
 * Three ways to get an identity:
 *   Qu.create()                        — generates a new one
 *   Qu.create({ identity })            — reuse a QuIdentity, or re-import
 *                                          previously exported keys ({signPub,...})
 *   Qu.create({ guest: true })         — ephemeral identity, but every
 *                                          write method throws: guests are
 *                                          read-only by construction, not
 *                                          merely by ACL happenstance.
 */
export class Qu {
  #runtime;
  #store;
  #session;
  #aclResolver;
  #putResolver;
  #resolveResolver;
  #guest;

  /**
   * Primary entry point — async because generating/importing keys is
   * inherently async.
   *
   * `mounts` is sugar for `store`: pass the same `{ prefix, adapter,
   * replicate? }[]` shape `new QuStore(mounts)` would take, without
   * constructing the QuStore yourself — this is the config-object answer to
   * "which StorageAdapter for which kind of data" (memory/session/
   * persistent, or a NullAdapter for a pure ephemeral event-bus mount, see
   * README's "Arten von Events"). Ignored if `store` is given directly.
   *
   * `plugins` is sugar for calling `.use(plugin)` once per entry, in order,
   * right after construction — for apps that always want Spaces/Files/
   * References/Network available without a separate `.use()` chain. See
   * `src/presets.js`'s `QU_PRESETS` for ready-made combinations:
   *   Qu.create({ plugins: QU_PRESETS.spaces })
   *
   * The stable default stays fully encapsulated: calling `Qu.create()`
   * without `runtime` always builds a brand-new, private Runtime+Store —
   * never a hidden global, never shared unless you explicitly pass
   * `runtime: other.runtime`. The FIRST `Qu.create()` call that builds a
   * given Runtime this way "owns" its `plugins` as that Runtime's default:
   * every LATER `Qu.create({ runtime })` call sharing it automatically gets
   * those same plugins installed too (plus any of its own), so a second
   * user/session on one process doesn't have to repeat the same `.use()`
   * chain. Passing an already-`Qu.create()`-wired `runtime` in without ever
   * having been the creator inherits nothing extra beyond what the creator
   * defined.
   */
  static async create({ identity, guest = false, runtime, store, mounts, plugins = [] } = {}) {
    const isNewRuntime = !runtime;
    const resolvedStore = store ?? new QuStore(mounts ?? [{ prefix: '', adapter: new MemoryAdapter() }]);
    const resolvedRuntime = runtime ?? new QuRuntime({ store: resolvedStore });
    const wired = wireRuntime(resolvedRuntime);

    let resolvedIdentity = null;
    if (identity) {
      resolvedIdentity = isQuIdentity(identity)
        ? identity
        : await QuIdentity.importKeys(identity.signPriv, identity.signPub, identity.encPriv, identity.encPub);
    } else if (!guest) {
      resolvedIdentity = await QuIdentity.generate();
    } else {
      resolvedIdentity = await QuIdentity.generate(); // guests still get a real, ephemeral identity — see class doc
    }

    const qu = new Qu({ runtime: resolvedRuntime, store: resolvedStore, identity: resolvedIdentity, guest, aclResolver: wired.resolver });

    if (isNewRuntime) {
      wired.defaultPlugins = plugins;
      for (const plugin of plugins) qu.use(plugin);
    } else {
      for (const plugin of wired.defaultPlugins ?? []) qu.use(plugin);
      for (const plugin of plugins) qu.use(plugin);
    }
    return qu;
  }

  /** Lower-level, synchronous constructor for when you already have a resolved identity/runtime (e.g. sharing a Runtime — pass `runtime: other.runtime`). Prefer `Qu.create()` unless you need this. */
  constructor({ runtime, store, identity = null, guest = false, aclResolver } = {}) {
    if (!runtime) throw new Error('[Qu] runtime is required — use Qu.create() unless you already have one');
    this.#runtime = runtime;
    this.#store = store ?? runtime.store;
    this.#guest = guest;
    this.#aclResolver = aclResolver ?? { current: createIdentityACL() };
    this.#putResolver = { current: defaultPutDispatch };
    this.#resolveResolver = { current: defaultResolveDispatch };
    this.#session = new QuSession(runtime, { identity, getACL: (id) => this.#aclResolver.current(id) });
  }

  // --- identity ---
  get fingerprint() { return this.#session.fingerprint; }
  get identity() { return this.#session.identity; }
  get isGuest() { return this.#guest; }
  get userSpaceId() { return this.fingerprint ? userSpaceId(this.fingerprint) : null; }
  async exportKeys() { return this.identity ? this.identity.exportKeys() : null; }
  async trustPeer(fingerprint, encPubKeyJwk) { return this.#session.trustPeer(fingerprint, encPubKeyJwk); }

  /**
   * Publishes this identity's public keys (and optionally a display
   * `alias`) under the three reserved leaves every User-Space structurally
   * supports (`~<fp>/pub`, `~<fp>/epub`, `~<fp>/alias` — core/space.js).
   * Needs no plugin: these are plain writes into your own always-writable
   * Space (core/identity-acl.js). This is what makes `encryptFor`'s default
   * (core/session.js) usable without every sender first having to
   * `trustPeer()` every recipient by hand — a sender who doesn't already
   * know a recipient's key falls back to reading it here. `pub`/`epub` are
   * always publicly readable regardless of any restricted `readers` list
   * you set on your own Space (modules/spaces.js) — encrypting your own
   * public key would make it undiscoverable to exactly the peers who need
   * it to decrypt anything from you at all.
   */
  async publishProfile({ alias } = {}) {
    if (this.#guest) throw new Error('[Qu] Guest-Sessions haben kein Schreibrecht (versucht: publishProfile).');
    const [pub, epub] = await Promise.all([
      this.identity.exportPublicSigningKey(),
      crypto.subtle.exportKey('jwk', this.identity.encryptionKey),
    ]);
    const writes = [this.own.get('pub').put(pub), this.own.get('epub').put(epub)];
    if (alias !== undefined) writes.push(this.own.get('alias').put(alias));
    await Promise.all(writes);
    return this;
  }

  /**
   * Reads another identity's (or your own) published profile — the read
   * side of `publishProfile()`. `alias` falls back to the fingerprint
   * itself when nobody ever published one, so a caller can always show
   * *something* without a separate null-check. Requires no plugin, same as
   * `publishProfile()` — `pub`/`epub`/`alias` are always readable
   * (core/space.js, modules/spaces.js).
   */
  async readProfile(fingerprint) {
    const space = this.get(userSpaceId(fingerprint));
    const [pub, epub, alias] = await Promise.all([space.get('pub'), space.get('epub'), space.get('alias')]);
    return { fingerprint, pub: pub?.value ?? null, epub: epub?.value ?? null, alias: alias?.value ?? fingerprint };
  }

  /**
   * A node bound to `id` — get/put/set/on/map relative to it (see
   * core/space-handle.js). Works for any Space/path you know: your own,
   * another user's ("~<their-fp>"), a generic Space (its UUID), or any
   * subpath of one. Building the node needs no plugin and does no
   * ACL/manifest lookup or I/O at all — only put/set/on/map/await do,
   * lazily, exactly as if you'd called the equivalent Session method with
   * the full id yourself.
   */
  get(id) {
    return new QuSpace(this.#session, id, {
      guest: this.#guest,
      putDispatch: (...args) => this.#putResolver.current(...args),
      resolveDispatch: (...args) => this.#resolveResolver.current(...args),
    });
  }

  /** `qu.own` is `qu.get(qu.userSpaceId)` — the ergonomic default for "my own Space", always available without any plugin. */
  get own() { return this.get(this.userSpaceId); }

  /**
   * Installs a plugin: either a plain `(qu) => {...}` function, or an
   * `{ install(qu) {...} }` object — the same shape `createFileHandlerPlugin()`,
   * `createReferenceHandlerPlugin()`, `createNetworkPlugin()` and
   * `createChatPlugin()` return (see src/data/, src/network/, src/modules/).
   * A plugin typically attaches convenience methods (`qu.connect`, ...)
   * and/or registers Runtime pipeline middleware (`qu.runtime.use(...)`)
   * and/or calls `setACLResolver()`/`setPutHandler()` — Qu itself has no
   * opinion about which.
   */
  use(plugin) {
    if (typeof plugin === 'function') plugin(this);
    else if (plugin && typeof plugin.install === 'function') plugin.install(this);
    else throw new Error('[Qu] plugin must be a function or an object with an install(qu) method');
    return this;
  }

  /**
   * Upgrades the ACL *policy* consulted by the Verify+ACL enforcement
   * middleware that's already running on this Qu's Runtime (registered
   * once, in `Qu.create()` — see wireRuntime() above). This is how
   * modules/spaces.js's createSpacesPlugin() adds generic multi-writer
   * Spaces and manifest-granted extra writers on a User-Space: it doesn't
   * (and can't) re-register middleware, it swaps which function that
   * middleware asks. Affects every Qu instance sharing this Runtime, not
   * just the one that called it — ACL is a property of the Space being
   * written to, not of who's asking.
   */
  setACLResolver(getACL) {
    this.#aclResolver.current = getACL;
    return this;
  }

  /**
   * Replaces the `put(session, id, value, opts)` dispatcher every node
   * `qu.get(id)`/`qu.own` produces uses for `.put()` — this is how
   * `createFileHandlerPlugin()` makes `node.put(bytes, opts)` auto-detect
   * files (chunk+manifest) instead of writing raw bytes as an opaque
   * value, without core/space-handle.js needing to know Files/plugins
   * exist. Unlike `setACLResolver()`, this is per-Qu-instance, not
   * per-Runtime — file handling is a property of which plugin THIS
   * instance loaded, not of the Space being written to.
   */
  setPutHandler(putDispatch) {
    this.#putResolver.current = putDispatch;
    return this;
  }

  /**
   * Replaces the `resolve(session, id) => Promise<string>` dispatcher every
   * node `qu.get(id)`/`qu.own` produces uses for put/set/on/map/await —
   * this is how `createReferenceHandlerPlugin()` makes those verbs
   * transparently follow chained `key://` redirects instead of treating
   * every id as literal, without core/space-handle.js needing to know
   * References/plugins exist. Unlike `setACLResolver()`, this is
   * per-Qu-instance, not per-Runtime — same reasoning as `setPutHandler()`.
   */
  setResolveHandler(resolveDispatch) {
    this.#resolveResolver.current = resolveDispatch;
    return this;
  }

  // --- escape hatch for advanced composition ---
  get runtime() { return this.#runtime; }
  get store() { return this.#store; }
  get session() { return this.#session; }
  /** The `getACL(id)` resolver this Qu instance's Session/ACL-enforcement currently use — the network plugin's `connect()` passes this to DefaultReplication so remote sync honors the same read-ACL as local reads. Always reflects the latest `setACLResolver()` call, even ones made after this getter was first read. */
  get acl() { return (id) => this.#aclResolver.current(id); }
}
