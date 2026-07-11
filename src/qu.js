import { QuRuntime } from './core/runtime.js';
import { QuStore } from './core/store.js';
import { QuSession } from './core/session.js';
import { QuIdentity } from './core/identity.js';
import { userSpaceId } from './core/space.js';
import { MemoryAdapter } from './adapters/memory.js';
import { createVerifyPlugin } from './core/verify.js';
import { createACLPlugin } from './core/acl.js';
import { createSpaceACLResolver, createSpace } from './modules/spaces.js';

// Tracks which Runtime instances already have the default Verify+ACL
// middleware installed, so sharing one Runtime across several `Qu`
// instances (e.g. several users on one server process) never registers
// the same middleware twice. A WeakSet here, not a property on the
// Runtime itself — Qu composes Runtime, it doesn't reach into it.
const wiredRuntimes = new WeakSet();

function isQuIdentity(x) {
  return x && typeof x.sign === 'function' && typeof x.fingerprint === 'string';
}

/**
 * Qu is the class most applications should actually instantiate — it wraps
 * Runtime + Store + Session + the Spaces ACL resolver behind plain instance
 * methods, so a caller doesn't need to assemble those pieces by hand for
 * the common case. QuRuntime/QuStore/QuSession/etc. remain the underlying
 * primitives (still directly usable — `qu.runtime` is the escape hatch)
 * for advanced composition: custom middleware ordering, non-default
 * adapters, or several `Qu` instances deliberately sharing one Runtime.
 *
 * Qu itself only knows Identity/Session/publish-get-query-on and the
 * default Space-ACL policy (zero network/storage-vendor dependency — safe
 * to use fully offline). Everything else — Files, References, Replication,
 * WebRTC, Chat — is a plugin, installed via `use()`. A plugin's underlying
 * functions (e.g. `sendMessage(qu, spaceId, opts)` in modules/chat.js)
 * always work standalone too; `use()` only adds convenience sugar
 * (`qu.sendMessage(spaceId, opts)`) on top for apps that want it.
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
  #acl;
  #guest;

  /** Primary entry point — async because generating/importing keys is inherently async. */
  static async create({ identity, guest = false, runtime, store } = {}) {
    const resolvedStore = store ?? new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
    const resolvedRuntime = runtime ?? new QuRuntime({ store: resolvedStore });
    const acl = createSpaceACLResolver(resolvedRuntime);

    if (!wiredRuntimes.has(resolvedRuntime)) {
      resolvedRuntime.use(createVerifyPlugin());
      resolvedRuntime.use(createACLPlugin(acl));
      wiredRuntimes.add(resolvedRuntime);
    }

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

    return new Qu({ runtime: resolvedRuntime, store: resolvedStore, identity: resolvedIdentity, guest, acl });
  }

  /** Lower-level, synchronous constructor for when you already have a resolved identity/runtime (e.g. sharing a Runtime — pass `runtime: other.runtime`). Prefer `Qu.create()` unless you need this. */
  constructor({ runtime, store, identity = null, guest = false, acl } = {}) {
    if (!runtime) throw new Error('[Qu] runtime is required — use Qu.create() unless you already have one');
    this.#runtime = runtime;
    this.#store = store ?? runtime.store;
    this.#guest = guest;
    this.#acl = acl ?? createSpaceACLResolver(runtime);
    this.#session = new QuSession(runtime, { identity, getACL: this.#acl });
  }

  // --- identity ---
  get fingerprint() { return this.#session.fingerprint; }
  get identity() { return this.#session.identity; }
  get isGuest() { return this.#guest; }
  get userSpaceId() { return this.fingerprint ? userSpaceId(this.fingerprint) : null; }
  async exportKeys() { return this.identity ? this.identity.exportKeys() : null; }

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

  // --- spaces (Space-ACL policy is the one optional module wired by default — see class doc: zero network/storage dependency, so it's still offline-safe) ---
  async createSpace(opts) {
    this.#assertCanWrite('createSpace');
    return createSpace(this.#session, opts);
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

  // --- escape hatch for advanced composition ---
  get runtime() { return this.#runtime; }
  get store() { return this.#store; }
  get session() { return this.#session; }
  /** The `getACL(id)` resolver this Qu instance's Session/ACL-enforcement use — the network plugin's `connect()` passes this to DefaultReplication so remote sync honors the same read-ACL as local reads. */
  get acl() { return this.#acl; }
}
