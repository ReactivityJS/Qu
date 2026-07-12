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
// currently in force" slot per Runtime.
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
const wiredRuntimes = new WeakMap(); // Runtime -> { resolver: { current: getACLFn } }

function wireRuntime(runtime) {
  let wired = wiredRuntimes.get(runtime);
  if (!wired) {
    const resolver = { current: createIdentityACL() };
    runtime.use(createVerifyPlugin());
    runtime.use(createACLPlugin((id) => resolver.current(id)));
    wired = { resolver };
    wiredRuntimes.set(runtime, wired);
  }
  return wired.resolver;
}

function isQuIdentity(x) {
  return x && typeof x.sign === 'function' && typeof x.fingerprint === 'string';
}

/**
 * Qu is the class most applications should actually instantiate — it wraps
 * Runtime + Store + Session behind plain instance methods, so a caller
 * doesn't need to assemble those pieces by hand for the common case.
 * QuRuntime/QuStore/QuSession/etc. remain the underlying
 * primitives (still directly usable — `qu.runtime` is the escape hatch)
 * for advanced composition: custom middleware ordering, non-default
 * adapters, or several `Qu` instances deliberately sharing one Runtime.
 *
 * Qu itself only knows Identity/Session/publish-get-query-on and one
 * structural ACL fact: you may always write under `~<your fingerprint>`,
 * nothing else (see core/identity-acl.js — this costs nothing, needs no
 * manifest or Storage round-trip, and follows directly from `fingerprint =
 * hash(pubKey)`, so it's a property of Identity, not a policy choice).
 * Everything else — generic multi-writer Spaces, Files, References,
 * Replication, WebRTC, Chat — is a plugin, installed via `use()`. A
 * plugin's underlying functions (e.g. `sendMessage(qu, spaceId, opts)` in
 * modules/chat.js) always work standalone too; `use()` only adds
 * convenience sugar (`qu.sendMessage(spaceId, opts)`) on top for apps that
 * want it. `qu.createSpace()` in particular does not exist until
 * `qu.use(createSpacesPlugin())` — see modules/spaces.js.
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
   * References/Network available without a separate `.use()` chain:
   *   Qu.create({ plugins: [createSpacesPlugin(), createFileHandlerPlugin({ fileStorage })] })
   */
  static async create({ identity, guest = false, runtime, store, mounts, plugins = [] } = {}) {
    const resolvedStore = store ?? new QuStore(mounts ?? [{ prefix: '', adapter: new MemoryAdapter() }]);
    const resolvedRuntime = runtime ?? new QuRuntime({ store: resolvedStore });
    const aclResolver = wireRuntime(resolvedRuntime);

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

    const qu = new Qu({ runtime: resolvedRuntime, store: resolvedStore, identity: resolvedIdentity, guest, aclResolver });
    for (const plugin of plugins) qu.use(plugin);
    return qu;
  }

  /** Lower-level, synchronous constructor for when you already have a resolved identity/runtime (e.g. sharing a Runtime — pass `runtime: other.runtime`). Prefer `Qu.create()` unless you need this. */
  constructor({ runtime, store, identity = null, guest = false, aclResolver } = {}) {
    if (!runtime) throw new Error('[Qu] runtime is required — use Qu.create() unless you already have one');
    this.#runtime = runtime;
    this.#store = store ?? runtime.store;
    this.#guest = guest;
    this.#aclResolver = aclResolver ?? { current: createIdentityACL() };
    this.#session = new QuSession(runtime, { identity, getACL: (id) => this.#aclResolver.current(id) });
  }

  // --- identity ---
  get fingerprint() { return this.#session.fingerprint; }
  get identity() { return this.#session.identity; }
  get isGuest() { return this.#guest; }
  get userSpaceId() { return this.fingerprint ? userSpaceId(this.fingerprint) : null; }
  async exportKeys() { return this.identity ? this.identity.exportKeys() : null; }

  /**
   * A QuSpace bound to `spaceId` — publish/append/get/query/on with paths
   * relative to that Space instead of spelled out in full each time. Works
   * for any Space you know the id of: your own, another user's
   * ("~<their-fp>"), or a generic Space (its UUID) — see core/space-handle.js.
   * Building the handle needs no plugin and does no manifest lookup; only
   * the actual calls made through it are ACL-checked, exactly as if you'd
   * called qu.publish()/qu.get() with the full id yourself.
   */
  space(spaceId) { return new QuSpace(this.#session, spaceId, { guest: this.#guest }); }

  /** `qu.own` is `qu.space(qu.userSpaceId)` — the ergonomic default for "my own Space", always available without any plugin (see core/identity-acl.js's structural default). */
  get own() { return this.space(this.userSpaceId); }

  #assertCanWrite(action) {
    if (this.#guest) throw new Error(`[Qu] Guest-Sessions haben kein Schreibrecht (versucht: ${action}). Mit Qu.create({ identity }) eine echte Identität verwenden.`);
  }

  // --- data (delegates to the underlying Session) ---
  async publish(id, value, opts) {
    this.#assertCanWrite('publish');
    return this.#session.publish(id, value, opts);
  }
  /** Collision-safe write for shared collections (chat messages, comments, activity events) — see QuSession.append(). */
  async append(collectionId, value, opts) {
    this.#assertCanWrite('append');
    return this.#session.append(collectionId, value, opts);
  }
  async get(id) { return this.#session.get(id); }
  async query(pattern) { return this.#session.query(pattern); }
  on(pattern, callback, opts) { return this.#session.on(pattern, callback, opts); }
  async resolveRefs(qubit) { return this.#session.resolveRefs(qubit); }
  async trustPeer(fingerprint, encPubKeyJwk) { return this.#session.trustPeer(fingerprint, encPubKeyJwk); }

  // --- profile: individual leaf QuBits directly under the User-Space root, not one combined object ---
  async publishProfile({ alias, epub, ...rest } = {}) {
    this.#assertCanWrite('publishProfile');
    const root = this.userSpaceId;
    await this.#session.publish(`${root}/pub`, this.fingerprint);
    if (alias !== undefined) await this.#session.publish(`${root}/alias`, alias);
    if (epub !== undefined) await this.#session.publish(`${root}/epub`, epub);
    for (const [key, value] of Object.entries(rest)) await this.#session.publish(`${root}/${key}`, value);
  }

  /** Reads another identity's public profile fields (alias/pub/epub/...) by their fingerprint — no manifest required to read, User-Spaces default to readers: ['*']. */
  async readProfile(fingerprint) {
    const root = userSpaceId(fingerprint);
    const [alias, pub, epub] = await Promise.all([
      this.#session.get(`${root}/alias`),
      this.#session.get(`${root}/pub`),
      this.#session.get(`${root}/epub`),
    ]);
    return { alias: alias?.value, pub: pub?.value, epub: epub?.value };
  }

  /**
   * Installs a plugin: either a plain `(qu) => {...}` function, or an
   * `{ install(qu) {...} }` object — the same shape `createFileHandlerPlugin()`,
   * `createReferenceHandlerPlugin()`, `createNetworkPlugin()` and
   * `createChatPlugin()` return (see src/data/, src/network/, src/modules/).
   * A plugin typically attaches convenience methods (`qu.shareFile`,
   * `qu.connect`, ...) and/or registers Runtime pipeline middleware
   * (`qu.runtime.use(...)`) — Qu itself has no opinion about which.
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

  // --- escape hatch for advanced composition ---
  get runtime() { return this.#runtime; }
  get store() { return this.#store; }
  get session() { return this.#session; }
  /** The `getACL(id)` resolver this Qu instance's Session/ACL-enforcement currently use — the network plugin's `connect()` passes this to DefaultReplication so remote sync honors the same read-ACL as local reads. Always reflects the latest `setACLResolver()` call, even ones made after this getter was first read. */
  get acl() { return (id) => this.#aclResolver.current(id); }
}
