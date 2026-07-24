/*! QU (qu-core) — Zero-Trust framework, gebündelt aus src/index.js. https://github.com/reactivityjs/qu */


// src/core/pipeline.js
var QuPipeline = class {
  #stages = [];
  use(fn) {
    this.#stages.push(fn);
    return this;
  }
  async run(ctx, final) {
    const stages = this.#stages;
    let i = -1;
    const dispatch = async (idx) => {
      if (idx <= i) throw new Error("[QuPipeline] next() called multiple times");
      i = idx;
      const fn = stages[idx];
      if (fn) return fn(ctx, () => dispatch(idx + 1));
      return final(ctx);
    };
    return dispatch(0);
  }
};

// src/core/debug.js
var listeners = /* @__PURE__ */ new Set();
function onDebug(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function debug(scope, event, data) {
  if (listeners.size === 0) return;
  const entry = { scope, event, data, ts: Date.now() };
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
    }
  }
}
function enableConsoleDebug({ filter = null } = {}) {
  return onDebug((entry) => {
    if (filter && !filter.includes(entry.scope)) return;
    const label = `[${entry.scope}:${entry.event}]`;
    if (entry.data instanceof Error || entry.event.includes("error") || entry.event.includes("reject")) {
      console.error(label, entry.data);
    } else {
      console.log(label, entry.data ?? "");
    }
  });
}

// src/core/pattern.js
function splitPath(pattern) {
  const clean = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  return clean.length ? clean.split("/") : [];
}
function assertValidPattern(pattern) {
  const segments = splitPath(pattern);
  const deepIndex = segments.indexOf("**");
  if (deepIndex !== -1 && deepIndex !== segments.length - 1) {
    throw new Error(`[Pattern] "**" ist nur als letztes Segment erlaubt, nicht mittig: "${pattern}"`);
  }
}

// src/core/subscriptions.js
var TrieNode = class {
  children = /* @__PURE__ */ new Map();
  // literal segment -> TrieNode
  starChild = null;
  // '*' -> TrieNode
  exact = [];
  // subs whose pattern ends exactly here
  deep = [];
  // subs whose pattern has '**' here (matches this node + anything below)
};
var QuSubscriptionEngine = class {
  #root = new TrieNode();
  #count = 0;
  subscribe(pattern, callback) {
    assertValidPattern(pattern);
    const segments = splitPath(pattern);
    let node = this.#root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === "**") {
        const entry2 = { callback, pattern };
        node.deep.push(entry2);
        this.#count++;
        return () => {
          const idx = node.deep.indexOf(entry2);
          if (idx !== -1) {
            node.deep.splice(idx, 1);
            this.#count--;
          }
        };
      }
      if (seg === "*") {
        node.starChild ??= new TrieNode();
        node = node.starChild;
      } else {
        let child = node.children.get(seg);
        if (!child) {
          child = new TrieNode();
          node.children.set(seg, child);
        }
        node = child;
      }
    }
    const entry = { callback, pattern };
    node.exact.push(entry);
    this.#count++;
    return () => {
      const idx = node.exact.indexOf(entry);
      if (idx !== -1) {
        node.exact.splice(idx, 1);
        this.#count--;
      }
    };
  }
  once(pattern, callback) {
    const off = this.subscribe(pattern, (q) => {
      off();
      callback(q);
    });
    return off;
  }
  get size() {
    return this.#count;
  }
  /** Returns the list of matching callbacks for a given qubit id, without invoking them. */
  match(id) {
    const segments = splitPath(id);
    const hits = [];
    const walk2 = (node, i) => {
      if (!node) return;
      if (node.deep.length) hits.push(...node.deep);
      if (i === segments.length) {
        if (node.exact.length) hits.push(...node.exact);
        return;
      }
      const seg = segments[i];
      walk2(node.children.get(seg), i + 1);
      walk2(node.starChild, i + 1);
    };
    walk2(this.#root, 0);
    return hits;
  }
  publish(qubit) {
    for (const { callback } of this.match(qubit.id)) {
      try {
        const result = callback(qubit);
        if (result && typeof result.catch === "function") {
          result.catch((e) => {
            debug("subscriptions", "listener-error", { id: qubit.id, error: e.message });
            console.error(`[QuSubscriptionEngine] async listener error for ${qubit.id}:`, e);
          });
        }
      } catch (e) {
        debug("subscriptions", "listener-error", { id: qubit.id, error: e.message });
        console.error(`[QuSubscriptionEngine] listener error for ${qubit.id}:`, e);
      }
    }
  }
};

// src/core/clock.js
var QuClock = class {
  #wall = Date.now();
  #seq = 0;
  next() {
    const now = Date.now();
    if (now > this.#wall) {
      this.#wall = now;
      this.#seq = 0;
    } else {
      this.#seq = Math.min(this.#seq + 1, 999);
    }
    return this.#wall + this.#seq / 1e3;
  }
  receive(remoteTs) {
    const w = Math.floor(remoteTs);
    if (w > this.#wall) {
      this.#wall = w;
      this.#seq = 0;
    }
  }
};

// src/core/subscribe-with-options.js
function subscribeWithOptions({ queryFn, subscribeFn, pattern, callback, initial = false, once = false }) {
  if (!initial && !once) {
    return subscribeFn(pattern, callback);
  }
  let unsubscribeInner = null;
  let cancelled = false;
  (async () => {
    const existing = await queryFn(pattern);
    existing.sort((a, b) => a.ts - b.ts);
    const seen = new Set(existing.map((q) => `${q.id}|${q.ts}`));
    for (const q of existing) {
      if (cancelled) return;
      callback(q);
    }
    if (once || cancelled) return;
    unsubscribeInner = subscribeFn(pattern, (q) => {
      if (seen.has(`${q.id}|${q.ts}`)) return;
      callback(q);
    });
  })();
  return () => {
    cancelled = true;
    if (unsubscribeInner) unsubscribeInner();
  };
}

// src/core/runtime.js
var QuRuntime = class {
  #store;
  #pipeline = new QuPipeline();
  #subs = new QuSubscriptionEngine();
  #clock = new QuClock();
  constructor({ store }) {
    this.#store = store;
  }
  /** Register commit-pipeline middleware (verify, ACL, schema checks, ...). Order matters: registered first runs first. */
  use(middleware) {
    this.#pipeline.use(middleware);
    return this;
  }
  /** Shared clock, so multiple Sessions writing through the same Runtime get consistent HLC ordering. */
  nextTs() {
    return this.#clock.next();
  }
  /** The one write path. `qubit` may or may not already carry sig/writer/pubKey — verify middleware decides whether that's required. */
  async ingest(qubit) {
    const ctx = { qubit: { ...qubit }, requireSignature: false };
    try {
      await this.#pipeline.run(ctx, async () => {
      });
    } catch (e) {
      debug("runtime", "ingest-rejected", { id: qubit.id, error: e.message });
      throw e;
    }
    const result = await this.#store.put(ctx.qubit);
    if (result.accepted && !result.noop) {
      debug("runtime", "ingest-accepted", { id: ctx.qubit.id, ts: ctx.qubit.ts, writer: ctx.qubit.writer });
      this.#subs.publish(ctx.qubit);
    } else if (result.noop) {
      debug("runtime", "ingest-noop", { id: ctx.qubit.id, ts: ctx.qubit.ts });
    } else {
      debug("runtime", "ingest-superseded", { id: ctx.qubit.id, ts: ctx.qubit.ts });
    }
    return { ...result, qubit: ctx.qubit };
  }
  /** Convenience for anonymous/unsigned local writes (no Session involved). Most real apps go through a Session instead. */
  async publish(id, value, opts = {}) {
    return this.ingest({ id, value, ts: opts.ts ?? this.nextTs() });
  }
  async get(id) {
    return this.#store.get(id);
  }
  async query(pattern) {
    assertValidPattern(pattern);
    const prefix = pattern.split(/[*]/)[0].replace(/\/$/, "");
    const all = await this.#store.query(prefix);
    const re = patternToRegExp(pattern);
    return all.filter((q) => re.test(q.id));
  }
  /**
   * `on(pattern, callback, { initial, once })`:
   *   - no options (default): forward-only, exactly as before — nothing
   *     already in the store is delivered, only future changes.
   *   - `initial: true`: deliver everything currently matching first,
   *     then keep delivering new/changed qubits.
   *   - `once: true`: deliver everything currently matching, then stop —
   *     no ongoing subscription. Equivalent to query() but through the
   *     same callback-based interface as everything else here.
   */
  on(pattern, callback, opts) {
    if (!opts) return this.#subs.subscribe(pattern, callback);
    return subscribeWithOptions({
      queryFn: (p) => this.query(p),
      subscribeFn: (p, cb) => this.#subs.subscribe(p, cb),
      pattern,
      callback,
      ...opts
    });
  }
  /** Ephemeral, unstored, unsigned event — for module-internal lifecycle signals, not data. */
  emit(topic, payload = {}) {
    this.#subs.publish({ id: topic, ...payload, ephemeral: true });
  }
  get store() {
    return this.#store;
  }
};
function patternToRegExp(pattern) {
  const escaped = pattern.split("/").map((seg) => seg === "**" ? ".*" : seg === "*" ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp(`^${escaped}$`);
}

// src/core/storage.js
function assertStorageAdapter(adapter) {
  const required = ["get", "put", "delete", "getAll"];
  for (const m of required) {
    if (typeof adapter[m] !== "function") {
      throw new Error(`[StorageAdapter] Object does not satisfy the StorageAdapter contract: missing "${m}"`);
    }
  }
  return adapter;
}

// src/core/store.js
function compareQubits(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const aw = a.writer ?? "";
  const bw = b.writer ?? "";
  if (aw !== bw) return aw < bw ? -1 : 1;
  return 0;
}
var QuStore = class {
  #mounts = [];
  // [{ prefix, adapter, replicate }], sorted longest-prefix-first
  constructor(mounts) {
    this.#mounts = [...mounts].map((m) => ({ replicate: true, ...m, adapter: assertStorageAdapter(m.adapter) })).sort((a, b) => b.prefix.length - a.prefix.length);
  }
  #resolve(id) {
    for (const m of this.#mounts) if (id.startsWith(m.prefix)) return m;
    throw new Error(`[QuStore] No mount matches id: ${id}`);
  }
  async get(id) {
    return this.#resolve(id).adapter.get(id);
  }
  /** Writes only if the incoming qubit wins against what's stored (see compareQubits() above) — never overwrites a winning local record. This is the immutability boundary. */
  async put(qubit) {
    const mount = this.#resolve(qubit.id);
    const existing = await mount.adapter.get(qubit.id);
    if (existing) {
      const cmp = compareQubits(qubit, existing);
      if (cmp < 0) return { accepted: false, existing };
      if (cmp === 0) return { accepted: true, existing, noop: true };
    }
    await mount.adapter.put(qubit.id, qubit);
    return { accepted: true };
  }
  async query(prefix) {
    const seen = /* @__PURE__ */ new Set();
    const results = [];
    for (const m of this.#mounts) {
      if (seen.has(m.adapter)) continue;
      if (prefix && !prefix.startsWith(m.prefix) && !m.prefix.startsWith(prefix)) continue;
      seen.add(m.adapter);
      const scanFrom = prefix && prefix.length > m.prefix.length ? prefix : m.prefix;
      const rows = await m.adapter.getAll(scanFrom);
      results.push(...rows);
    }
    return results;
  }
  mountFor(id) {
    return this.#resolve(id).prefix;
  }
  /** Declarative replication policy — checked by Replication providers BEFORE ACL, so "local-only" is a hard boundary, not a convention a sync strategy might forget to honor. */
  isReplicable(id) {
    return this.#resolve(id).replicate !== false;
  }
};

// src/core/sign.js
function canonical(qubit) {
  const v = typeof qubit.value === "string" ? qubit.value : JSON.stringify(qubit.value);
  const r = JSON.stringify(qubit.refs ?? []);
  return `${qubit.id}|${v}|${qubit.ts}|${r}`;
}

// src/core/bytes.js
function toB64(bytes) {
  const arr = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  if (typeof Buffer !== "undefined") return Buffer.from(arr).toString("base64");
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromB64(b64) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/core/crypto.js
var AESGCM = { name: "AES-GCM", length: 256 };
var ECDH_ALG = { name: "ECDH", namedCurve: "P-256" };
async function deriveWrapKey(ecdhPrivateKey, ecdhPublicKey, salt, info) {
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: ecdhPublicKey }, ecdhPrivateKey, 256);
  const hkdfKey = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(info) },
    hkdfKey,
    AESGCM,
    false,
    ["encrypt", "decrypt"]
  );
}
async function wrapContentKeyForRecipients(recipients, rawContentKey) {
  const ephemeral = await crypto.subtle.generateKey(ECDH_ALG, true, ["deriveBits"]);
  const ephemeralPubJwk = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keys = {};
  for (const r of recipients) {
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, r.ecdhPublicKey, salt, r.fingerprint);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wrapIv }, wrapKey, rawContentKey);
    keys[r.fingerprint] = { iv: toB64(wrapIv), wrapped: toB64(wrapped) };
  }
  return { ephemeralPubKey: ephemeralPubJwk, salt: toB64(salt), keys };
}
async function unwrapContentKey(identity, envelope) {
  const entry = envelope.keys[identity.fingerprint];
  if (!entry) return void 0;
  const ephemeralPub = await crypto.subtle.importKey("jwk", envelope.ephemeralPubKey, ECDH_ALG, true, []);
  const salt = fromB64(envelope.salt);
  const wrapKey = await deriveWrapKey(identity.encryptionPrivateKey, ephemeralPub, salt, identity.fingerprint);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(entry.iv) }, wrapKey, fromB64(entry.wrapped));
}
async function encryptFor(recipients, plaintextValue) {
  const contentKey = await crypto.subtle.generateKey(AESGCM, true, ["encrypt", "decrypt"]);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(plaintextValue));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: contentIv }, contentKey, plaintext);
  const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
  const wrap3 = await wrapContentKeyForRecipients(recipients, rawContentKey);
  return {
    __qu_enc: 1,
    alg: "ECDH-P256+HKDF-SHA256+AES-256-GCM",
    ephemeralPubKey: wrap3.ephemeralPubKey,
    salt: wrap3.salt,
    iv: toB64(contentIv),
    ciphertext: toB64(ciphertext),
    keys: wrap3.keys
  };
}
async function decryptWith(identity, envelope) {
  const rawContentKey = await unwrapContentKey(identity, envelope);
  if (rawContentKey === void 0) return void 0;
  const contentKey = await crypto.subtle.importKey("raw", rawContentKey, AESGCM, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, contentKey, fromB64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function encryptBytesFor(recipients, plaintextBytes) {
  const contentKey = await crypto.subtle.generateKey(AESGCM, true, ["encrypt", "decrypt"]);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: contentIv }, contentKey, plaintextBytes));
  const rawContentKey = await crypto.subtle.exportKey("raw", contentKey);
  const wrap3 = await wrapContentKeyForRecipients(recipients, rawContentKey);
  return {
    envelope: { alg: "ECDH-P256+HKDF-SHA256+AES-256-GCM", ephemeralPubKey: wrap3.ephemeralPubKey, salt: wrap3.salt, iv: toB64(contentIv), keys: wrap3.keys },
    ciphertext
  };
}
async function decryptBytesWith(identity, envelope, ciphertext) {
  const rawContentKey = await unwrapContentKey(identity, envelope);
  if (rawContentKey === void 0) return void 0;
  const contentKey = await crypto.subtle.importKey("raw", rawContentKey, AESGCM, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, contentKey, ciphertext);
  return new Uint8Array(plaintext);
}

// src/core/space.js
function spaceIdOf(id) {
  const clean = id.startsWith("/") ? id.slice(1) : id;
  const i = clean.indexOf("/");
  return i === -1 ? clean : clean.slice(0, i);
}
function isUserSpaceId(spaceId) {
  return spaceId.startsWith("~");
}
function userSpaceId(fingerprint) {
  return `~${fingerprint}`;
}
function fingerprintOfUserSpace(spaceId) {
  return isUserSpaceId(spaceId) ? spaceId.slice(1) : null;
}
function randomSpaceId() {
  return crypto.randomUUID();
}
var RESERVED_PROFILE_PATHS = ["pub", "epub", "alias"];
function isReservedProfilePath(id) {
  const clean = id.startsWith("/") ? id.slice(1) : id;
  const spaceId = spaceIdOf(clean);
  if (!isUserSpaceId(spaceId)) return false;
  return RESERVED_PROFILE_PATHS.includes(clean.slice(spaceId.length + 1));
}

// src/core/acl.js
function createACLPlugin(getACL) {
  return async (ctx, next) => {
    const q = ctx.qubit;
    const acl = await getACL(q.id);
    if (!acl || !acl.writers || acl.writers.includes("*")) return next();
    if (!q.writer || !acl.writers.includes(q.writer)) {
      throw new Error(`[ACL] Write denied for ${q.writer ?? "anonymous"} on ${q.id}`);
    }
    await next();
  };
}
async function filterForReader(qubits, readerFingerprint, getACL) {
  const bySpace = /* @__PURE__ */ new Map();
  for (const q of qubits) {
    const space = spaceIdOf(q.id);
    if (!bySpace.has(space)) bySpace.set(space, []);
    bySpace.get(space).push(q);
  }
  const out = [];
  for (const [space, group] of bySpace) {
    const acl = await getACL(group[0].id);
    if (!acl || !acl.readers || acl.readers.includes("*") || acl.readers.includes(readerFingerprint)) {
      out.push(...group);
    }
  }
  return out;
}

// src/core/space-handle.js
var QuSpace = class _QuSpace {
  #session;
  #id;
  #guest;
  #putDispatch;
  #resolveDispatch;
  #subscribeDispatch;
  /**
   * `putDispatch(session, id, value, opts)`, if given, replaces the default
   * `session.publish(id, value, opts)` for put() — this is the hook
   * createFileHandlerPlugin()/qu.setPutHandler() installs so put()'s
   * Uint8Array auto-detection works without QuSpace (Core) needing to know
   * Files/plugins exist at all. Defaults to plain publish() so QuSpace
   * stays usable standalone (e.g. modules/spaces.js's createSpace()).
   *
   * `resolveDispatch(session, id)`, if given, replaces the default identity
   * function `async (s, id) => id` — this is the hook
   * createReferenceHandlerPlugin()/qu.setResolveHandler() installs so
   * put/set/on/map/await transparently follow chained `key://` redirects
   * without QuSpace (Core) needing to know References/plugins exist at
   * all. See the module doc comment above and data/references.js's
   * resolveKeyChain() for the full mechanism.
   *
   * `subscribeDispatch(session, topic)`, if given, replaces the default
   * no-op `async () => {}` — this is the hook createNetworkPlugin()/
   * qu.setSubscribeHandler() installs so on()/map() ask every currently
   * connected peer to actually push matching writes, instead of setting up
   * a listener that only ever sees local activity. Fire-and-forget from
   * on()/map()'s perspective — see their doc comments below.
   */
  constructor(session, spaceId, { guest = false, putDispatch, resolveDispatch, subscribeDispatch } = {}) {
    this.#session = session;
    this.#id = String(spaceId);
    this.#guest = guest;
    this.#putDispatch = putDispatch ?? ((s, id, value, opts) => s.publish(id, value, opts));
    this.#resolveDispatch = resolveDispatch ?? (async (s, id) => id);
    this.#subscribeDispatch = subscribeDispatch ?? (async () => {
    });
  }
  get id() {
    return this.#id;
  }
  toString() {
    return this.#id;
  }
  toJSON() {
    return this.#id;
  }
  /** Escape hatch, same as qu.runtime — lets a QuSpace be passed anywhere a Qu instance was expected (e.g. ui/bindings.js's bindKey(), which needs runtime.nextTs() for its echo guard). */
  get runtime() {
    return this.#session.runtime;
  }
  /**
   * Escape hatch, same as qu.session — for callers that need a one-shot
   * array of matches (session.query()) rather than the live/single-value
   * shape get()/on()/map() give, e.g. data/references.js's obj://
   * resolution. Also the way to read a node's value WITHOUT reference
   * resolution (`await node` always resolves — there's no options
   * parameter on the thenable protocol to pass `{ raw: true }` to):
   * `await node.session.get(node.id)`.
   */
  get session() {
    return this.#session;
  }
  /**
   * Reading this node's own current value — `await node` and `node.then()`
   * are the same thing. Transparently follows a chained `key://` redirect
   * first (if a ReferenceHandler is installed, see class doc) — the
   * returned QuBit's `.id` reflects wherever resolution actually landed,
   * not necessarily this node's own id, so `qu.get((await node).id)`
   * keeps navigating into the resolved target. No options parameter here
   * (the thenable protocol) — use `await node.session.get(node.id)` for
   * the raw, unresolved read.
   */
  then(onFulfilled, onRejected) {
    return this.#resolveDispatch(this.#session, this.#id).then((targetId) => this.#session.get(targetId)).then(onFulfilled, onRejected);
  }
  #assertCanWrite(action) {
    if (this.#guest) throw new Error(`[QuSpace] Guest-Sessions haben kein Schreibrecht (versucht: ${action} auf ${this.#id}). Mit Qu.create({ identity }) eine echte Identit\xE4t verwenden.`);
  }
  /** Navigate to a child node — synchronous, no I/O, just builds `${id}/${subpath}`. */
  get(subpath) {
    if (!subpath) return this;
    return new _QuSpace(this.#session, `${this.#id}/${subpath}`, { guest: this.#guest, putDispatch: this.#putDispatch, resolveDispatch: this.#resolveDispatch, subscribeDispatch: this.#subscribeDispatch });
  }
  /**
   * Write AT this node (LWW) — a single named value, `await node` reads it
   * back. Resolves this node's own id through a chained `key://` redirect
   * FIRST (so writing "through" an alias lands at the real target, whose
   * OWN ACL then applies — see class doc), then bytes route through
   * putDispatch — plain publish() unless a FileHandler is configured. Pass
   * `{ raw: true }` to write at the literal id, skipping resolution.
   */
  async put(value, opts) {
    this.#assertCanWrite("put");
    const targetId = opts?.raw ? this.#id : await this.#resolveDispatch(this.#session, this.#id);
    return this.#putDispatch(this.#session, targetId, value, opts);
  }
  /**
   * Collision-safe write into an array-like collection AT this node —
   * creates a new child, never writes to this node itself (`await node`
   * stays null). Resolves this node's own id through a chained `key://`
   * redirect first (same as put()), so the new child lands under the real
   * collection, not a literal alias path. See QuSession.append(). Pass
   * `{ raw: true }` to skip resolution.
   */
  async set(value, opts) {
    this.#assertCanWrite("set");
    const targetId = opts?.raw ? this.#id : await this.#resolveDispatch(this.#session, this.#id);
    return this.#session.append(targetId, value, opts);
  }
  /**
   * Live subscription to this node's own value. Resolves this node's own
   * id through a chained `key://` redirect exactly ONCE, when the
   * subscription activates — never per incoming event, and never
   * re-resolved if the reference is repointed later (tear down and
   * re-subscribe for that). Still returns an unsubscribe function
   * SYNCHRONOUSLY (resolution + the real subscription happen in the
   * background; calling the returned function before that finishes is
   * safe and results in no delivery, same pattern as
   * subscribe-with-options.js's `initial`/`once` catch-up).
   *
   * Also asks every currently connected peer (via subscribeDispatch, see
   * class doc) to start pushing this topic — fire-and-forget, does NOT
   * delay or gate the local listener above, which activates purely from
   * local state regardless of network latency/availability. Without
   * createNetworkPlugin() installed this is a no-op; without ANY active
   * connection yet it's a harmless no-op too (nothing to ask).
   *
   * Pass `{ raw: true }` for the old, purely synchronous, zero-setup-gap
   * behavior against the literal id (no resolution, no network request).
   */
  on(callback, opts) {
    if (opts?.raw) return this.#session.on(this.#id, callback, opts);
    let unsubscribeInner = null;
    let cancelled = false;
    this.#resolveDispatch(this.#session, this.#id).then((targetId) => {
      if (cancelled) return;
      unsubscribeInner = this.#session.on(targetId, callback, opts);
      this.#subscribeDispatch(this.#session, targetId).catch((e) => console.error(`[QuSpace] on(): Netzwerk-Subscribe f\xFCr "${targetId}" fehlgeschlagen:`, e));
    }).catch((e) => {
      if (!cancelled) console.error(`[QuSpace] on(): Aufl\xF6sen von "${this.#id}" fehlgeschlagen:`, e);
    });
    return () => {
      cancelled = true;
      if (unsubscribeInner) unsubscribeInner();
    };
  }
  /**
   * Live subscription to this node's children — `${id}/*` (already matches
   * set()-created entries too, since set() namespaces one segment deep,
   * same as a directly-keyed put() collection), or `${id}/**` with
   * `{ deep: true }` for a genuinely deeper hierarchy an app built itself
   * (e.g. leaf-per-field items, <qu-list>). Defaults to `initial: true`
   * (deliver what already exists, then keep delivering live) — unlike
   * on(), which defaults to forward-only, map()'s whole point is "give me
   * everything here, kept live", matching what every current caller
   * (viewObject(), <qu-list>) already wants; pass `{ initial: false }` for
   * forward-only.
   *
   * Resolves this node's own id through a chained `key://` redirect once,
   * at activation, exactly like on() — so `appSpace.get('currentBoard').map(cb)`
   * live-subscribes to whichever board is CURRENTLY pointed at, without
   * re-resolving per event. Also asks every currently connected peer to
   * push this topic (subscribeDispatch, fire-and-forget — see on()'s doc
   * comment, same reasoning applies here). Pass `{ raw: true }` to skip
   * both resolution and the network request.
   */
  map(callback, { deep = false, initial = true, raw = false, ...opts } = {}) {
    if (raw) {
      const pattern = deep ? `${this.#id}/**` : `${this.#id}/*`;
      return this.#session.on(pattern, callback, { initial, ...opts });
    }
    let unsubscribeInner = null;
    let cancelled = false;
    this.#resolveDispatch(this.#session, this.#id).then((targetId) => {
      if (cancelled) return;
      const pattern = deep ? `${targetId}/**` : `${targetId}/*`;
      unsubscribeInner = this.#session.on(pattern, callback, { initial, ...opts });
      this.#subscribeDispatch(this.#session, targetId).catch((e) => console.error(`[QuSpace] map(): Netzwerk-Subscribe f\xFCr "${targetId}" fehlgeschlagen:`, e));
    }).catch((e) => {
      if (!cancelled) console.error(`[QuSpace] map(): Aufl\xF6sen von "${this.#id}" fehlgeschlagen:`, e);
    });
    return () => {
      cancelled = true;
      if (unsubscribeInner) unsubscribeInner();
    };
  }
};

// src/core/session.js
var ECDH_ALG2 = { name: "ECDH", namedCurve: "P-256" };
var QuSession = class {
  #runtime;
  #identity;
  #getACL;
  #peers = /* @__PURE__ */ new Map();
  // fingerprint -> ECDH CryptoKey, for encryptFor() targets
  constructor(runtime, { identity = null, getACL = null } = {}) {
    this.#runtime = runtime;
    this.#identity = identity;
    this.#getACL = getACL;
  }
  get fingerprint() {
    return this.#identity?.fingerprint ?? null;
  }
  get identity() {
    return this.#identity;
  }
  get runtime() {
    return this.#runtime;
  }
  /** Learn another identity's ECDH public key out-of-band, so this Session can encrypt data *for* them. (Signature verification never needs this — fingerprint = hash(pubKey) is enough.) Takes precedence over a published `~<fp>/epub` if both are known. */
  async trustPeer(fingerprint, encPubJwk) {
    this.#peers.set(fingerprint, await crypto.subtle.importKey("jwk", encPubJwk, ECDH_ALG2, true, []));
  }
  /**
   * `encryptFor` omitted entirely (not `null`/`[]` — those are an explicit
   * opt-out) on a write into a Space whose CURRENT `readers` list is
   * something other than `['*']` defaults to encrypting for exactly that
   * list (plus the writer itself, so a sender can always read their own
   * write even if the manifest's `readers` doesn't happen to include them).
   * Nothing changes for the common case: without the Spaces plugin (or with
   * a public Space), `getACL()` always reports `readers: ['*']`, so this is
   * a no-op there — encryption stays exactly what a caller asks for, same
   * as before. Manifest writes and the reserved profile leaves
   * (`~<fp>/pub|epub|alias`, core/space.js) are excluded structurally: a
   * manifest holds the ACL/routing decisions THIS logic itself depends on
   * (encrypting it would blind every future `getACL()` call, including this
   * one), and encrypting your own public key would make it undiscoverable
   * to exactly the peers who need it to decrypt anything from you at all.
   */
  async #defaultRecipients(id) {
    if (!this.#getACL || !this.fingerprint) return null;
    if (id === spaceIdOf(id) || isReservedProfilePath(id)) return null;
    const acl = await this.#getACL(id);
    const readers = acl?.readers;
    if (!readers || readers.includes("*")) return null;
    return [.../* @__PURE__ */ new Set([...readers, this.fingerprint])];
  }
  /**
   * Resolves one recipient's ECDH public key: self (own identity), a peer
   * already known via `trustPeer()`, or — the fallback that makes default
   * group-encryption actually usable without every sender manually
   * `trustPeer()`-ing every reader first — their self-published
   * `~<fp>/epub` (core/space.js's reserved profile leaf, always readable
   * regardless of that Space's own `readers` list, see
   * modules/spaces.js). A raw `runtime.get()` here, not `this.get()`: this
   * is an internal crypto-material lookup for a recipient the CALLER is
   * already entitled to address (they're on the target Space's `readers`
   * list), not a general "read anyone's profile" read path — read-ACL on
   * the recipient's own Space is irrelevant to it. Resolved keys are
   * cached in `#peers` exactly like an explicit `trustPeer()` call.
   */
  async #resolveRecipientKey(fingerprint) {
    if (fingerprint === this.fingerprint) return { fingerprint, ecdhPublicKey: this.#identity.encryptionKey };
    let key = this.#peers.get(fingerprint);
    if (!key) {
      const q = await this.#runtime.get(`${userSpaceId(fingerprint)}/epub`);
      if (q?.value) {
        try {
          key = await crypto.subtle.importKey("jwk", q.value, ECDH_ALG2, true, []);
          this.#peers.set(fingerprint, key);
        } catch (e) {
          debug("session", "epub-import-failed", { fingerprint, error: e.message });
        }
      }
    }
    if (!key) throw new Error(`[Session] Unknown ECDH public key for recipient "${fingerprint}" \u2014 call trustPeer() first, or have them publish it (Qu#publishProfile()).`);
    return { fingerprint, ecdhPublicKey: key };
  }
  /**
   * Public sibling of #resolveRecipientKey() for callers that need
   * resolved `{ fingerprint, ecdhPublicKey }` pairs OUTSIDE a single
   * publish() call — namely data/files/manifest.js, which encrypts a
   * file's raw bytes (core/crypto.js's encryptBytesFor()) once, separate
   * from the manifest QuBit that later gets published with the same
   * `encryptFor` list. Same resolution publish()'s own encryptFor uses
   * internally (self, an already-trustPeer()ed peer, or their published
   * `~<fp>/epub`) — no separate mechanism, no duplicated trust logic.
   */
  async resolveEncryptionRecipients(fingerprints) {
    return Promise.all(fingerprints.map((fp) => this.#resolveRecipientKey(fp)));
  }
  async publish(id, plainValue, { ts, encryptFor: recipients, refs } = {}) {
    id = String(id);
    if (plainValue instanceof QuSpace) {
      throw new Error(`[Session] publish()/put()/set() erhielt eine QuSpace-Instanz als WERT, nicht als Id \u2014 das ist fast immer ein Versehen. F\xFCr eine explizite Referenz auf einen anderen Space: node.put(keyRef(otherSpace.id)) (data/references.js), nicht node.put(otherSpace).`);
    }
    let value = plainValue;
    if (recipients === void 0) recipients = await this.#defaultRecipients(id);
    if (recipients && recipients.length) {
      if (!this.#identity) throw new Error("[Session] Cannot encrypt without an identity");
      const targets = await Promise.all(recipients.map((fp) => this.#resolveRecipientKey(fp)));
      value = await encryptFor(targets, plainValue);
    }
    const qubit = { id, value, ts: ts ?? this.#runtime.nextTs() };
    if (refs) qubit.refs = refs;
    if (this.#identity) {
      qubit.writer = this.#identity.fingerprint;
      qubit.sig = await this.#identity.sign(canonical(qubit));
      qubit.pubKey = await this.#identity.exportPublicSigningKey();
    }
    return this.#runtime.ingest(qubit);
  }
  /**
   * `publish(id, ...)` is a named, mutable slot — the same id written twice
   * is one Last-Write-Wins register (by design, e.g. a Space Manifest or a
   * profile field). That's the wrong tool for "many independent writers
   * each adding their own item to a shared collection" (chat messages,
   * comments, activity events): if two different writers ever choose the
   * same id there, one write silently replaces the other — not a security
   * hole (both signatures are genuinely valid), but a real data-loss bug.
   *
   * append() is the other mode: it namespaces the id by the writer's own
   * fingerprint before publishing, `${collectionId}/${fingerprint}-${ts}`.
   * Two different writers can now never collide (different fingerprint =
   * different path segment, structurally, not by convention someone has to
   * remember), and no ACL special-casing is needed — `spaceIdOf(id)` is
   * still the same collection's Space either way, so write-ACL/read-ACL
   * are checked exactly like any other publish(). This is the standard
   * LWW-Register vs. (writer-partitioned) grow-only-Set split from CRDT
   * theory, not a one-off convention invented for chat.
   *
   * `fingerprint` and `ts` are joined with `-` into ONE path segment, not
   * two (`${collectionId}/${fingerprint}-${ts}`, not
   * `${collectionId}/${fingerprint}/${ts}`) — deliberately: a QuSpace
   * built directly under `collectionId` is exactly one level deep, exactly
   * like a put()-addressed collection (`list.get(itemId).put(v)`). A
   * caller enumerating a collection's items never needs to know whether it
   * was built with put() or set() to pick the right `map()`/query() depth
   * — `${id}/*` (map()'s default) already finds set()-created entries.
   * Getting this wrong used to fail silently: `${id}/*` structurally
   * cannot match a path two segments deep, so `node.map(cb)` without
   * `{ deep: true }` on a set()-based collection returned nothing at all —
   * no error, the data just never appeared.
   */
  async append(collectionId, plainValue, opts = {}) {
    if (!this.#identity) throw new Error("[Session] append() requires an identity \u2014 anonymous writes cannot be namespaced");
    const ts = opts.ts ?? this.#runtime.nextTs();
    const id = `${collectionId}/${this.#identity.fingerprint}-${ts}`;
    return this.publish(id, plainValue, { ...opts, ts });
  }
  async #decrypt(qubit) {
    if (!qubit || !qubit.value || qubit.value.__qu_enc !== 1) return qubit;
    if (!this.#identity) return { ...qubit, value: void 0, encrypted: true };
    const plain = await decryptWith(this.#identity, qubit.value);
    if (plain === void 0) return { ...qubit, value: void 0, encrypted: true };
    return { ...qubit, value: plain };
  }
  async get(id) {
    const q = await this.#runtime.get(String(id));
    if (q && this.#getACL) {
      const [visible] = await filterForReader([q], this.fingerprint, this.#getACL);
      if (!visible) return null;
    }
    return this.#decrypt(q);
  }
  async query(pattern) {
    let rows = await this.#runtime.query(String(pattern));
    if (this.#getACL) rows = await filterForReader(rows, this.fingerprint, this.#getACL);
    return Promise.all(rows.map((q) => this.#decrypt(q)));
  }
  /** See Runtime.on() for `initial`/`once` semantics — this is the same thing, but every delivered qubit (initial batch and live) goes through decrypt() first, matching query()'s existing behaviour. */
  on(pattern, callback, opts) {
    pattern = String(pattern);
    const decryptedSubscribe = (p, cb) => this.#runtime.on(p, (q) => {
      this.#decrypt(q).then(cb).catch((e) => {
        debug("session", "on-callback-error", { id: q.id, error: e.message });
        console.error(`[Session] on() callback failed for ${q.id}:`, e);
      });
    });
    if (!opts) return decryptedSubscribe(pattern, callback);
    return subscribeWithOptions({
      queryFn: (p) => this.query(p),
      // already decrypted + ACL-filtered
      subscribeFn: decryptedSubscribe,
      pattern,
      callback,
      ...opts
    });
  }
  /** Resolves a QuBit's refs to the QuBits they point at (decrypted if this Session can). Manual, not automatic/reactive — Core stays a dumb store, apps decide when to follow a link. */
  async resolveRefs(qubit) {
    if (!qubit?.refs?.length) return [];
    return Promise.all(qubit.refs.map((id) => this.get(id)));
  }
};

// src/core/identity.js
var ENC = new TextEncoder();
var ECDSA = { name: "ECDSA", namedCurve: "P-256" };
var ECDH = { name: "ECDH", namedCurve: "P-256" };
function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
}
async function fingerprintOfSpki(spkiBuf) {
  const hash = await crypto.subtle.digest("SHA-256", spkiBuf);
  return toHex(hash).slice(0, 24);
}
async function fingerprintOfPublicKey(pubKey) {
  const spki = await crypto.subtle.exportKey("spki", pubKey);
  return fingerprintOfSpki(spki);
}
var FINGERPRINT_RE = /^[0-9a-f]{24}$/i;
function isValidFingerprint(value) {
  return typeof value === "string" && FINGERPRINT_RE.test(value.trim());
}
var QuIdentity = class _QuIdentity {
  #signKP;
  #encKP;
  #fp = null;
  constructor(signKP, encKP) {
    this.#signKP = signKP;
    this.#encKP = encKP;
  }
  get publicKey() {
    return this.#signKP.publicKey;
  }
  get privateKey() {
    return this.#signKP.privateKey;
  }
  get encryptionKey() {
    return this.#encKP.publicKey;
  }
  get encryptionPrivateKey() {
    return this.#encKP.privateKey;
  }
  get fingerprint() {
    return this.#fp;
  }
  static async generate() {
    const signKP = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
    const encKP = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
    const id = new _QuIdentity(signKP, encKP);
    id.#fp = await fingerprintOfPublicKey(signKP.publicKey);
    return id;
  }
  async sign(data) {
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.#signKP.privateKey, ENC.encode(data));
    return toHex(sig);
  }
  async exportPublicSigningKey() {
    return crypto.subtle.exportKey("jwk", this.#signKP.publicKey);
  }
  async exportKeys() {
    return {
      signPub: await crypto.subtle.exportKey("jwk", this.#signKP.publicKey),
      signPriv: await crypto.subtle.exportKey("jwk", this.#signKP.privateKey),
      encPub: await crypto.subtle.exportKey("jwk", this.#encKP.publicKey),
      encPriv: await crypto.subtle.exportKey("jwk", this.#encKP.privateKey)
    };
  }
  static async importKeys(signPriv, signPub, encPriv, encPub) {
    const signKP = {
      privateKey: await crypto.subtle.importKey("jwk", signPriv, ECDSA, true, ["sign"]),
      publicKey: await crypto.subtle.importKey("jwk", signPub, ECDSA, true, ["verify"])
    };
    const encKP = {
      privateKey: await crypto.subtle.importKey("jwk", encPriv, ECDH, true, ["deriveBits"]),
      publicKey: await crypto.subtle.importKey("jwk", encPub, ECDH, true, [])
    };
    const id = new _QuIdentity(signKP, encKP);
    id.#fp = await fingerprintOfPublicKey(signKP.publicKey);
    return id;
  }
};
async function verifySignature(data, sigHex, pubKey) {
  try {
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, fromHex(sigHex), ENC.encode(data));
  } catch {
    return false;
  }
}

// src/adapters/memory.js
var MemoryAdapter = class {
  #s = /* @__PURE__ */ new Map();
  async get(id) {
    return this.#s.get(id) ?? null;
  }
  async put(id, q) {
    this.#s.set(id, q);
  }
  async delete(id) {
    this.#s.delete(id);
  }
  async getAll(prefix = "") {
    const r = [];
    for (const [k, v] of this.#s) if (k.startsWith(prefix)) r.push(v);
    return r;
  }
  async clear() {
    this.#s.clear();
  }
};

// src/core/verify.js
var ECDSA2 = { name: "ECDSA", namedCurve: "P-256" };
function createVerifyPlugin(known = {}) {
  return async (ctx, next) => {
    const q = ctx.qubit;
    if (!q.sig || !q.writer) {
      if (ctx.requireSignature) throw new Error("[Verify] Missing signature or writer");
      return next();
    }
    let pubKey = known[q.writer];
    if (!pubKey) {
      if (!q.pubKey) throw new Error(`[Verify] No public key available for writer ${q.writer}`);
      pubKey = await crypto.subtle.importKey("jwk", q.pubKey, ECDSA2, true, ["verify"]);
      const derivedFp = await fingerprintOfPublicKey(pubKey);
      if (derivedFp !== q.writer) {
        throw new Error(`[Verify] Fingerprint mismatch: claimed writer ${q.writer} does not match embedded key (${derivedFp})`);
      }
    }
    const valid = await verifySignature(canonical(q), q.sig, pubKey);
    if (!valid) throw new Error(`[Verify] Invalid signature from ${q.writer}`);
    await next();
  };
}

// src/core/identity-acl.js
function createIdentityACL() {
  return async function getACL(id) {
    const spaceId = spaceIdOf(id);
    if (!isUserSpaceId(spaceId)) return { writers: [], readers: ["*"] };
    return { writers: [fingerprintOfUserSpace(spaceId)], readers: ["*"] };
  };
}

// src/qu.js
var wiredRuntimes = /* @__PURE__ */ new WeakMap();
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
  return x && typeof x.sign === "function" && typeof x.fingerprint === "string";
}
function isBytesLike(value) {
  return value instanceof Uint8Array || typeof Blob !== "undefined" && value instanceof Blob || typeof File !== "undefined" && value instanceof File;
}
var defaultPutDispatch = (session, id, value, opts) => {
  if (isBytesLike(value)) {
    throw new Error(`[Qu] put() hat Datei-Bytes f\xFCr "${id}" erhalten, aber kein FileHandler ist konfiguriert. qu.use(createFileHandlerPlugin({ fileStorage })) hinzuf\xFCgen, oder rohe Bytes bewusst \xFCber qu.session.publish() schreiben.`);
  }
  return session.publish(id, value, opts);
};
var defaultResolveDispatch = async (session, id) => id;
var defaultSubscribeDispatch = async () => {
};
var Qu = class _Qu {
  #runtime;
  #store;
  #session;
  #aclResolver;
  #putResolver;
  #resolveResolver;
  #subscribeResolver;
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
    const resolvedStore = store ?? new QuStore(mounts ?? [{ prefix: "", adapter: new MemoryAdapter() }]);
    const resolvedRuntime = runtime ?? new QuRuntime({ store: resolvedStore });
    const wired = wireRuntime(resolvedRuntime);
    let resolvedIdentity = null;
    if (identity) {
      resolvedIdentity = isQuIdentity(identity) ? identity : await QuIdentity.importKeys(identity.signPriv, identity.signPub, identity.encPriv, identity.encPub);
    } else if (!guest) {
      resolvedIdentity = await QuIdentity.generate();
    } else {
      resolvedIdentity = await QuIdentity.generate();
    }
    const qu = new _Qu({ runtime: resolvedRuntime, store: resolvedStore, identity: resolvedIdentity, guest, aclResolver: wired.resolver });
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
    if (!runtime) throw new Error("[Qu] runtime is required \u2014 use Qu.create() unless you already have one");
    this.#runtime = runtime;
    this.#store = store ?? runtime.store;
    this.#guest = guest;
    this.#aclResolver = aclResolver ?? { current: createIdentityACL() };
    this.#putResolver = { current: defaultPutDispatch };
    this.#resolveResolver = { current: defaultResolveDispatch };
    this.#subscribeResolver = { current: defaultSubscribeDispatch };
    this.#session = new QuSession(runtime, { identity, getACL: (id) => this.#aclResolver.current(id) });
  }
  // --- identity ---
  get fingerprint() {
    return this.#session.fingerprint;
  }
  get identity() {
    return this.#session.identity;
  }
  get isGuest() {
    return this.#guest;
  }
  get userSpaceId() {
    return this.fingerprint ? userSpaceId(this.fingerprint) : null;
  }
  async exportKeys() {
    return this.identity ? this.identity.exportKeys() : null;
  }
  async trustPeer(fingerprint, encPubKeyJwk) {
    return this.#session.trustPeer(fingerprint, encPubKeyJwk);
  }
  /**
   * Publishes this identity's public keys and a display `alias` under the
   * three reserved leaves every User-Space structurally supports
   * (`~<fp>/pub`, `~<fp>/epub`, `~<fp>/alias` — core/space.js). Needs no
   * plugin: these are plain writes into your own always-writable Space
   * (core/identity-acl.js). This is what makes `encryptFor`'s default
   * (core/session.js) usable without every sender first having to
   * `trustPeer()` every recipient by hand — a sender who doesn't already
   * know a recipient's key falls back to reading it here. `pub`/`epub` are
   * always publicly readable regardless of any restricted `readers` list
   * you set on your own Space (modules/spaces.js) — encrypting your own
   * public key would make it undiscoverable to exactly the peers who need
   * it to decrypt anything from you at all.
   *
   * `alias` is ALWAYS written, defaulting to the fingerprint itself when
   * omitted — deliberately, so `alias` is never a special case for a
   * reader: it is never "missing", only ever "still the fingerprint,
   * because nobody chose a custom one yet". A caller reads `alias` and
   * only `alias`, with no separate null-check and no
   * fingerprint-vs-display-name branch anywhere downstream.
   */
  async publishProfile({ alias } = {}) {
    if (this.#guest) throw new Error("[Qu] Guest-Sessions haben kein Schreibrecht (versucht: publishProfile).");
    const [pub, epub] = await Promise.all([
      this.identity.exportPublicSigningKey(),
      crypto.subtle.exportKey("jwk", this.identity.encryptionKey)
    ]);
    await Promise.all([
      this.own.get("pub").put(pub),
      this.own.get("epub").put(epub),
      this.own.get("alias").put(alias ?? this.fingerprint)
    ]);
    return this;
  }
  /**
   * Reads another identity's (or your own) published profile — the read
   * side of `publishProfile()`. `alias` falls back to the fingerprint
   * itself if it somehow was never published (e.g. read before the first
   * publishProfile() call ever landed) — publishProfile() itself always
   * writes it, so this is a defensive fallback, not the normal path.
   * Requires no plugin, same as `publishProfile()` — `pub`/`epub`/`alias`
   * are always readable (core/space.js, modules/spaces.js).
   */
  async readProfile(fingerprint) {
    const space = this.get(userSpaceId(fingerprint));
    const [pub, epub, alias] = await Promise.all([space.get("pub"), space.get("epub"), space.get("alias")]);
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
      subscribeDispatch: (...args) => this.#subscribeResolver.current(...args)
    });
  }
  /** `qu.own` is `qu.get(qu.userSpaceId)` — the ergonomic default for "my own Space", always available without any plugin. */
  get own() {
    return this.get(this.userSpaceId);
  }
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
    if (typeof plugin === "function") plugin(this);
    else if (plugin && typeof plugin.install === "function") plugin.install(this);
    else throw new Error("[Qu] plugin must be a function or an object with an install(qu) method");
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
  /**
   * Replaces the `subscribe(session, topic) => Promise<void>` dispatcher
   * every node `qu.get(id)`/`qu.own` produces calls (fire-and-forget) from
   * on()/map() — this is how `createNetworkPlugin()` makes those verbs
   * actually ask every currently connected peer to push matching writes,
   * instead of only ever seeing local activity. Per-Qu-instance, not
   * per-Runtime — same reasoning as `setPutHandler()`/`setResolveHandler()`.
   */
  setSubscribeHandler(subscribeDispatch) {
    this.#subscribeResolver.current = subscribeDispatch;
    return this;
  }
  // --- escape hatch for advanced composition ---
  get runtime() {
    return this.#runtime;
  }
  get store() {
    return this.#store;
  }
  get session() {
    return this.#session;
  }
  /** The `getACL(id)` resolver this Qu instance's Session/ACL-enforcement currently use — the network plugin's `connect()` passes this to DefaultReplication so remote sync honors the same read-ACL as local reads. Always reflects the latest `setACLResolver()` call, even ones made after this getter was first read. */
  get acl() {
    return (id) => this.#aclResolver.current(id);
  }
};

// src/modules/spaces.js
function createSpaceACLResolver(runtime) {
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
      admins.add(owner);
      const readers = isReservedProfilePath(id) ? ["*"] : m?.readers ?? ["*"];
      return {
        writers: isManifestWrite ? [...admins] : [...writers],
        readers
      };
    }
    if (!m) return { writers: ["*"], readers: ["*"] };
    const contentReaders = m.readers ?? ["*"];
    return {
      writers: isManifestWrite ? m.admins ?? [] : m.writers ?? [],
      readers: isManifestWrite ? [.../* @__PURE__ */ new Set([...contentReaders, ...m.admins ?? []])] : contentReaders
    };
  };
}
function buildManifest(fingerprint, { writers = [], readers = ["*"], admins } = {}) {
  return { admins: admins ?? (fingerprint ? [fingerprint] : []), writers, readers, createdAt: Date.now() };
}
async function createSpace(session, opts) {
  const spaceId = randomSpaceId();
  await session.publish(spaceId, buildManifest(session.fingerprint, opts));
  return spaceId;
}
var MANIFEST_ROLES = ["writers", "readers", "admins"];
async function patchManifestRole(session, spaceId, role, mutate) {
  if (!MANIFEST_ROLES.includes(role)) {
    throw new Error(`[Spaces] Ung\xFCltige Rolle "${role}" (erwartet "writers", "readers" oder "admins").`);
  }
  const manifestQ = await session.get(spaceId);
  const manifest = manifestQ?.value;
  if (!manifest) throw new Error(`[Spaces] Kein Manifest unter "${spaceId}" \u2014 Space existiert (f\xFCr diesen Client) noch nicht/noch nicht gesynct.`);
  return session.publish(spaceId, { ...manifest, [role]: mutate(manifest[role] ?? []) });
}
async function addToRole(session, spaceId, role, fingerprint) {
  return patchManifestRole(session, spaceId, role, (list) => list.includes(fingerprint) ? list : [...list, fingerprint]);
}
async function removeFromRole(session, spaceId, role, fingerprint) {
  return patchManifestRole(session, spaceId, role, (list) => list.filter((fp) => fp !== fingerprint));
}
async function createSpaceAt(session, id, opts) {
  await session.publish(id, buildManifest(session.fingerprint, opts));
  return id;
}
function createSpacesPlugin() {
  return {
    install(qu) {
      qu.setACLResolver(createSpaceACLResolver(qu.runtime));
      qu.createSpace = (opts) => {
        if (qu.isGuest) throw new Error("[Spaces] Guest-Sessions haben kein Schreibrecht (versucht: createSpace). Mit Qu.create({ identity }) eine echte Identit\xE4t verwenden.");
        const spaceId = randomSpaceId();
        const space = qu.get(spaceId);
        space.ready = qu.session.publish(spaceId, buildManifest(qu.fingerprint, opts));
        space.ready.catch((e) => console.error(`[Spaces] createSpace(): manifest write for ${spaceId} failed:`, e));
        return space;
      };
      qu.createSpaceAt = (id, opts) => {
        if (qu.isGuest) throw new Error("[Spaces] Guest-Sessions haben kein Schreibrecht (versucht: createSpaceAt). Mit Qu.create({ identity }) eine echte Identit\xE4t verwenden.");
        const space = qu.get(id);
        space.ready = qu.session.publish(id, buildManifest(qu.fingerprint, opts));
        space.ready.catch((e) => console.error(`[Spaces] createSpaceAt(): manifest write for ${id} failed:`, e));
        return space;
      };
      qu.addToRole = (spaceId, role, fingerprint) => addToRole(qu.session, spaceId, role, fingerprint);
      qu.removeFromRole = (spaceId, role, fingerprint) => removeFromRole(qu.session, spaceId, role, fingerprint);
    }
  };
}

// src/network/handshake.js
var ECDSA3 = { name: "ECDSA", namedCurve: "P-256" };
function randomChallenge() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function authenticateChannel(channel, identity = null, { timeoutMs = 8e3 } = {}) {
  const myChallenge = randomChallenge();
  let resolveTheirs, rejectTheirs;
  const theirsPromise = new Promise((res, rej) => {
    resolveTheirs = res;
    rejectTheirs = rej;
  });
  const timer = setTimeout(() => rejectTheirs(new Error("[Handshake] Timed out waiting for peer proof")), timeoutMs);
  const off = channel.onMessage(async (msg) => {
    if (msg.type === "qu.auth.hello") {
      if (!identity) {
        await channel.send({ type: "qu.auth.proof", writer: null });
        return;
      }
      const sig = await identity.sign(msg.challenge);
      const pubKey = await identity.exportPublicSigningKey();
      await channel.send({ type: "qu.auth.proof", writer: identity.fingerprint, sig, pubKey });
      return;
    }
    if (msg.type === "qu.auth.proof") {
      clearTimeout(timer);
      if (!msg.writer) {
        resolveTheirs(null);
        return;
      }
      try {
        const pubKey = await crypto.subtle.importKey("jwk", msg.pubKey, ECDSA3, true, ["verify"]);
        const derivedFp = await fingerprintOfPublicKey(pubKey);
        if (derivedFp !== msg.writer) throw new Error("fingerprint mismatch");
        const valid = await verifySignature(myChallenge, msg.sig, pubKey);
        if (!valid) throw new Error("invalid proof signature");
        resolveTheirs(msg.writer);
      } catch (e) {
        rejectTheirs(new Error(`[Handshake] Peer proof rejected: ${e.message}`));
      }
    }
  });
  await channel.send({ type: "qu.auth.hello", challenge: myChallenge });
  try {
    return await theirsPromise;
  } finally {
    off();
  }
}

// src/network/router.js
var Router = class {
  #routes = /* @__PURE__ */ new Map();
  // channelId -> route
  /**
   * route: {
   *   channelId: string,
   *   channel: Channel,
   *   pushTopics: string[],
   *   role: 'mirror' | 'sync',
   *   group?: string | null,   // only meaningful for role: 'sync'
   *   metric?: number,          // lower = preferred; default 0
   *   transport?: string,        // free-form label ('relay' | 'webrtc' | ...), for introspection/debugging only
   *   peerFingerprint?: string | null,
   * }
   */
  addRoute(route) {
    if (!route.channelId) throw new Error("[Router] route.channelId is required");
    this.#routes.set(route.channelId, { metric: 0, group: null, transport: null, peerFingerprint: null, ...route });
  }
  removeRoute(channelId) {
    this.#routes.delete(channelId);
  }
  updateMetric(channelId, metric) {
    const r = this.#routes.get(channelId);
    if (r) r.metric = metric;
  }
  getRoute(channelId) {
    return this.#routes.get(channelId) ?? null;
  }
  get routes() {
    return [...this.#routes.values()];
  }
  #matches(route, qubit) {
    return route.pushTopics.some((t) => qubit.id.startsWith(t));
  }
  /** The channels that should receive `qubit` right now — mirrors always, plus the best sync route per group, plus every ungrouped sync route. */
  resolve(qubit) {
    const active = this.routes.filter((r) => this.#matches(r, qubit));
    const mirrors = active.filter((r) => r.role === "mirror");
    const syncRoutes = active.filter((r) => r.role === "sync");
    const grouped = /* @__PURE__ */ new Map();
    const ungrouped = [];
    for (const r of syncRoutes) {
      if (r.group == null) {
        ungrouped.push(r);
        continue;
      }
      if (!grouped.has(r.group)) grouped.set(r.group, []);
      grouped.get(r.group).push(r);
    }
    const chosen = [...ungrouped];
    for (const candidates of grouped.values()) {
      const best = Math.min(...candidates.map((r) => r.metric));
      chosen.push(...candidates.filter((r) => r.metric === best));
    }
    return [...mirrors, ...chosen];
  }
  /** Convenience for a single route to ask "am I one of the chosen ones for this qubit?" — what DefaultReplication actually calls. */
  isChosen(channelId, qubit) {
    return this.resolve(qubit).some((r) => r.channelId === channelId);
  }
};

// src/core/channel.js
function safeInvoke(fn, arg, scope) {
  try {
    const result = fn(arg);
    if (result && typeof result.catch === "function") {
      result.catch((e) => {
        debug(scope, "listener-error", e);
        console.error(`[${scope}] unhandled error in message listener:`, e);
      });
    }
  } catch (e) {
    debug(scope, "listener-error", e);
    console.error(`[${scope}] error in message listener:`, e);
  }
}
function assertChannel(ch) {
  const required = ["connect", "send", "onMessage", "onClose", "close"];
  for (const m of required) {
    if (typeof ch[m] !== "function") {
      throw new Error(`[Channel] Object does not satisfy the Channel contract: missing "${m}"`);
    }
  }
  if (typeof ch.id !== "string" || !ch.id) {
    throw new Error('[Channel] Object does not satisfy the Channel contract: missing string "id"');
  }
  return ch;
}
function createLoopbackChannelPair(idA = "loopback-a", idB = "loopback-b") {
  function makeSide(id) {
    const listeners2 = /* @__PURE__ */ new Set();
    const closeListeners = /* @__PURE__ */ new Set();
    let pending = [];
    return {
      side: {
        id,
        async connect() {
        },
        onMessage(fn) {
          listeners2.add(fn);
          if (pending.length) {
            const buffered = pending;
            pending = [];
            for (const obj of buffered) listeners2.forEach((f) => safeInvoke(f, obj, "channel:loopback"));
          }
          return () => listeners2.delete(fn);
        },
        onClose(fn) {
          closeListeners.add(fn);
          return () => closeListeners.delete(fn);
        }
      },
      deliver(msg) {
        if (listeners2.size === 0) {
          pending.push(msg);
          return;
        }
        listeners2.forEach((fn) => safeInvoke(fn, msg, "channel:loopback"));
      },
      fireClose() {
        closeListeners.forEach((fn) => fn());
      }
    };
  }
  const sideA = makeSide(idA);
  const sideB = makeSide(idB);
  const a = {
    ...sideA.side,
    async send(msg) {
      queueMicrotask(() => sideB.deliver(msg));
    },
    async close() {
      sideA.fireClose();
      sideB.fireClose();
    }
  };
  const b = {
    ...sideB.side,
    async send(msg) {
      queueMicrotask(() => sideA.deliver(msg));
    },
    async close() {
      sideA.fireClose();
      sideB.fireClose();
    }
  };
  return { a: assertChannel(a), b: assertChannel(b) };
}

// src/network/ingest-gate.js
function requireDirectWriterGate() {
  return async (ctx, next) => {
    if (ctx.qubit?.writer !== ctx.peerFingerprint) {
      throw new Error(`[IngestGate] push rejected: writer "${ctx.qubit?.writer}" is not this connection's own proven fingerprint "${ctx.peerFingerprint}" (requireDirectWriter)`);
    }
    return next();
  };
}
function rateLimitGate(rateLimiter) {
  return async (ctx, next) => {
    const key = ctx.qubit?.writer ?? ctx.peerFingerprint ?? ctx.channelId;
    if (!rateLimiter.allow(key)) {
      throw new Error(`[IngestGate] push rejected: rate limit exceeded for "${key}"`);
    }
    return next();
  };
}

// src/network/replication/default.js
var DefaultReplication = class {
  #runtime;
  #channel;
  #channelId;
  #getACL;
  #peerFingerprint;
  #repairWindowMs;
  #lastSync = /* @__PURE__ */ new Map();
  // topic -> last known-good `since` cursor
  #pending = /* @__PURE__ */ new Map();
  #reqId = 0;
  #off;
  #offPush;
  #recentlyFromPeer = /* @__PURE__ */ new Map();
  // `${id}|${ts}` -> true, bounded LRU-ish de-echo cache
  #pushTopics;
  #router;
  #ingestGate;
  #allowDynamicSubscribe;
  #maxDynamicTopics;
  #dynamicTopicsAdded = 0;
  constructor(runtime, channel, {
    getACL = async () => null,
    peerFingerprint = null,
    repairWindowMs = 5 * 60 * 1e3,
    pushTopics = [],
    router = null,
    // optional — see core/router.js. Unset: identical behaviour to before the Router existed.
    // All three opt-in, all about INCOMING `qu.push` only — see
    // #handleMessage and network/ingest-gate.js. None change outgoing
    // behavior (still governed by ACL/pushTopics/Router as before), and
    // none are on unless the caller asks for them — existing callers
    // (Qu.connect(), a bare `new DefaultReplication()`) keep today's
    // behavior unchanged. requireDirectWriter/rateLimiter are shorthand for
    // the two built-in gates (network/ingest-gate.js's
    // requireDirectWriterGate()/rateLimitGate()) — reach for `ingestGate`
    // directly for a custom policy instead of a fourth constructor flag.
    requireDirectWriter = false,
    // true: only accept a push whose qubit.writer is THIS channel's own proven peerFingerprint — rejects relayed/forwarded qubits, enforcing a star topology where the Relay only ever hears a write from its actual author. A qubit's signature already makes forgery impossible either way; this is about WHO may hand a given write to this particular connection, not about authenticity.
    rateLimiter = null,
    // a createRateLimiter() instance (network/rate-limiter.js), or any `{ allow(key) => boolean }`. Keyed by the incoming qubit's writer (falls back to peerFingerprint, then the channel id, for the rare anonymous/unsigned case) — one peer flooding writes never starves another peer's budget.
    ingestGate = [],
    // additional `(ctx, next) => Promise<void>` middleware, ctx = { qubit, peerFingerprint, channelId } — run after requireDirectWriter/rateLimiter, in array order. Throw to reject (same convention as core/acl.js), call next() to allow.
    // Runtime topic registration — see subscribe()/#handleSubscribeRequest()
    // below and README's "Relay App-unabhängig betreiben" section.
    // `false` (default): a `qu.subscribe` message from the peer is ignored —
    // byte-identical to behavior before this option existed. `true`: any
    // requested topic is honored (still ACL-gated at actual push time,
    // exactly like the static `pushTopics` above — see #maybePush; this
    // option only widens WHICH topics get a chance to be pushed, never who
    // may read them). `string[]`: a hard ceiling — a requested topic is only
    // honored if it falls within one of these prefixes (`topic.startsWith(c)`
    // for some `c`); anything outside is silently ignored. The "restrict a
    // relay to one or more App-Space ids" case (a genuine security/scoping
    // decision an operator makes, unlike the ACL check below).
    allowDynamicSubscribe = false,
    // Cap on how many topics a single connection may register via
    // `qu.subscribe` beyond its initial `pushTopics` — protects a relay's
    // memory/CPU from one connection registering unbounded topics. On by
    // default (not opt-in) because, unlike requireDirectWriter/rateLimiter,
    // there's no scenario where an unbounded per-connection topic count is
    // actually desired.
    maxDynamicTopics = 200
  } = {}) {
    this.#runtime = runtime;
    this.#channel = assertChannel(channel);
    this.#channelId = channel.id;
    this.#getACL = getACL;
    this.#peerFingerprint = peerFingerprint;
    this.#repairWindowMs = repairWindowMs;
    this.#pushTopics = [...pushTopics];
    this.#router = router;
    this.#allowDynamicSubscribe = allowDynamicSubscribe;
    this.#maxDynamicTopics = maxDynamicTopics;
    this.#ingestGate = new QuPipeline();
    if (requireDirectWriter) this.#ingestGate.use(requireDirectWriterGate());
    if (rateLimiter) this.#ingestGate.use(rateLimitGate(rateLimiter));
    for (const gate of ingestGate) this.#ingestGate.use(gate);
    this.#off = channel.onMessage((msg) => this.#handleMessage(msg));
    if (this.#pushTopics.length) this.#ensurePushListening();
  }
  #rememberFromPeer(q) {
    const key = `${q.id}|${q.ts}`;
    this.#recentlyFromPeer.set(key, true);
    if (this.#recentlyFromPeer.size > 500) {
      this.#recentlyFromPeer.delete(this.#recentlyFromPeer.keys().next().value);
    }
  }
  async #isVisible(q) {
    if (!this.#runtime.store.isReplicable(q.id)) return false;
    const [visible] = await filterForReader([q], this.#peerFingerprint, this.#getACL);
    return !!visible;
  }
  /** Lazily wires the runtime.on('**') listener #maybePush() needs — a relay started with NO initial pushTopics (the "unbound" case) has nothing to push until the first qu.subscribe arrives; this activates it then, instead of unconditionally in the constructor. */
  #ensurePushListening() {
    if (!this.#offPush) this.#offPush = this.#runtime.on("**", (q) => this.#maybePush(q));
  }
  /**
   * Handles an incoming `qu.subscribe` request (see subscribe() below) —
   * the peer asking THIS side to start pushing a topic to it at runtime,
   * instead of only whatever was configured at construction time.
   * `#allowDynamicSubscribe` gates whether this is honored at all (see the
   * constructor doc comment); `#maxDynamicTopics` bounds how many NEW
   * topics one connection may add this way. Neither check is a security
   * boundary by itself — #maybePush()/#isVisible() still runs the same
   * ACL check on every candidate qubit regardless of how a topic ended up
   * in #pushTopics; this only decides which topics get a CHANCE to be
   * pushed at all.
   */
  #handleSubscribeRequest(topic) {
    topic = String(topic);
    if (this.#pushTopics.includes(topic)) return;
    if (this.#allowDynamicSubscribe === false) {
      debug("replication", "subscribe-rejected-disabled", { topic, channelId: this.#channelId });
      return;
    }
    if (Array.isArray(this.#allowDynamicSubscribe) && !this.#allowDynamicSubscribe.some((c) => topic.startsWith(c))) {
      debug("replication", "subscribe-rejected-outside-ceiling", { topic, channelId: this.#channelId });
      return;
    }
    if (this.#dynamicTopicsAdded >= this.#maxDynamicTopics) {
      debug("replication", "subscribe-rejected-cap", { topic, channelId: this.#channelId, cap: this.#maxDynamicTopics });
      return;
    }
    this.#pushTopics.push(topic);
    this.#dynamicTopicsAdded++;
    this.#ensurePushListening();
    debug("replication", "subscribe-accepted", { topic, channelId: this.#channelId });
  }
  async #maybePush(q) {
    if (q.ephemeral) return;
    if (this.#recentlyFromPeer.has(`${q.id}|${q.ts}`)) return;
    if (!this.#pushTopics.some((t) => q.id.startsWith(t))) return;
    if (this.#router && this.#router.getRoute(this.#channelId) && !this.#router.isChosen(this.#channelId, q)) {
      debug("replication", "push-skipped-by-router", { id: q.id, channelId: this.#channelId });
      return;
    }
    try {
      if (!await this.#isVisible(q)) return;
      await this.#channel.send({ type: "qu.push", qubit: q });
      debug("replication", "push-sent", { id: q.id });
    } catch (e) {
      debug("replication", "push-failed", { id: q.id, error: e.message });
      console.error(`[Replication] failed to push ${q.id}:`, e.message);
    }
  }
  async #handleMessage(msg) {
    if (msg.type === "qu.subscribe") {
      this.#handleSubscribeRequest(msg.topic);
      return;
    }
    if (msg.type === "qu.push") {
      try {
        const ctx = { qubit: msg.qubit, peerFingerprint: this.#peerFingerprint, channelId: this.#channelId };
        await this.#ingestGate.run(ctx, async () => {
        });
      } catch (e) {
        debug("replication", "push-rejected-by-gate", { id: msg.qubit?.id, writer: msg.qubit?.writer, error: e.message });
        return;
      }
      this.#rememberFromPeer(msg.qubit);
      try {
        await this.#runtime.ingest(msg.qubit);
        debug("replication", "push-ingested", { id: msg.qubit.id });
      } catch (e) {
        debug("replication", "push-rejected", { id: msg.qubit?.id, error: e.message });
        console.error(`[Replication] rejected incoming push for ${msg.qubit?.id}:`, e.message);
      }
      return;
    }
    if (msg.type === "qu.sync.request") {
      const ownDoc = await this.#runtime.get(msg.topic);
      const rows = await this.#runtime.query(`${msg.topic}/**`);
      const all = ownDoc ? [ownDoc, ...rows] : rows;
      const inRange = all.filter((q) => q.ts >= msg.since);
      const replicable = inRange.filter((q) => this.#runtime.store.isReplicable(q.id));
      const visible = await filterForReader(replicable, this.#peerFingerprint, this.#getACL);
      debug("replication", "sync-response", { topic: msg.topic, count: visible.length });
      await this.#channel.send({ type: "qu.sync.response", reqId: msg.reqId, qubits: visible });
      if (msg.reciprocal !== false) {
        this.#request(msg.topic, this.#lastSync.get(msg.topic) ?? 0, { reciprocal: false }).then((r) => this.#lastSync.set(msg.topic, r.cursor)).catch((e) => debug("replication", "reciprocal-sync-failed", { topic: msg.topic, error: e.message }));
      }
      return;
    }
    if (msg.type === "qu.sync.response") {
      const resolver = this.#pending.get(msg.reqId);
      if (resolver) {
        this.#pending.delete(msg.reqId);
        resolver(msg.qubits);
      }
      return;
    }
    if (msg.type === "qu.has") {
      const q = await this.#runtime.get(msg.id);
      const has = !!q && (msg.ts == null || q.ts === msg.ts) && await this.#isVisible(q);
      await this.#channel.send({ type: "qu.has.response", reqId: msg.reqId, has });
      return;
    }
    if (msg.type === "qu.has.response") {
      const resolver = this.#pending.get(msg.reqId);
      if (resolver) {
        this.#pending.delete(msg.reqId);
        resolver(msg.has);
      }
    }
  }
  async #genericRequest(message, timeoutMs) {
    const reqId = ++this.#reqId;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(reqId, resolve);
      setTimeout(() => {
        if (this.#pending.has(reqId)) {
          this.#pending.delete(reqId);
          reject(new Error("[DefaultReplication] request timed out"));
        }
      }, timeoutMs);
    });
    await this.#channel.send({ ...message, reqId });
    return p;
  }
  /**
   * Asks the peer on the other end of this channel "do you already have
   * qubit `id`?" (optionally verifying the exact `ts` too, for the rare
   * case an id could legitimately be rewritten). A lightweight existence
   * probe, NOT a substitute for sync()'s bulk reconciliation — meant for
   * "was this one write I'm actively watching actually delivered to the
   * relay yet" UI feedback (e.g. a sent-message tick that's stuck on
   * "pending" forever is worse than no feedback at all), not for checking
   * a whole room's history in a loop. See DefaultFileTransfer's
   * `waitUntilReady()` for the same idea applied to file chunks.
   */
  async hasRemote(id, { ts = null, timeoutMs = 8e3 } = {}) {
    return this.#genericRequest({ type: "qu.has", id, ts }, timeoutMs);
  }
  /**
   * Polls hasRemote() until it reports `true` or `maxWaitMs` elapses —
   * covers both "the relay just hasn't gotten around to it yet" (retry a
   * few times) and "we were offline when we wrote this, only just
   * reconnected" (the caller decides when to (re)call this — e.g. once
   * per reconnect, see the chat example app — it isn't itself reconnect-
   * aware). Returns `false`, not a thrown error, on timeout — same
   * "unconfirmed, try again later" convention as DefaultFileTransfer's
   * waitUntilReady().
   */
  async waitUntilReplicated(id, { ts = null, intervalMs = 1e3, maxWaitMs = 3e4 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        if (await this.hasRemote(id, { ts, timeoutMs: Math.min(8e3, maxWaitMs) })) return true;
      } catch (e) {
        debug("replication", "has-check-failed", { id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }
  async #request(topic, since, { reciprocal = true } = {}) {
    const reqId = ++this.#reqId;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(reqId, resolve);
      setTimeout(() => {
        if (this.#pending.has(reqId)) {
          this.#pending.delete(reqId);
          reject(new Error("[DefaultReplication] sync request timed out"));
        }
      }, 1e4);
    });
    debug("replication", "sync-request", { topic, since, reciprocal });
    await this.#channel.send({ type: "qu.sync.request", reqId, topic, since, reciprocal });
    const qubits = await p;
    let maxTs = since;
    for (const q of qubits) {
      this.#rememberFromPeer(q);
      try {
        await this.#runtime.ingest(q);
      } catch (e) {
        debug("replication", "sync-item-rejected", { id: q.id, error: e.message });
        console.error(`[Replication] rejected qubit ${q.id} from sync response:`, e.message);
        continue;
      }
      if (q.ts > maxTs) maxTs = q.ts;
    }
    return { received: qubits.length, cursor: maxTs };
  }
  /** Bidirectional by construction (see class doc): also flushes whatever the peer wrote while disconnected. */
  async sync({ topic, since = this.#lastSync.get(topic) ?? 0 }) {
    const { cursor } = await this.#request(topic, since);
    this.#lastSync.set(topic, cursor);
    this.#runtime.emit("sync.complete", { topic, cursor });
    return cursor;
  }
  async repair({ topic, since = this.#lastSync.get(topic) ?? 0 }) {
    const overlapSince = Math.max(0, since - this.#repairWindowMs);
    const { cursor } = await this.#request(topic, overlapSince);
    this.#lastSync.set(topic, Math.max(cursor, since));
    this.#runtime.emit("repair.complete", { topic, cursor });
    return cursor;
  }
  async snapshot({ topic }) {
    return this.sync({ topic, since: 0 });
  }
  /**
   * Asks the PEER on the other end of this channel to start pushing `topic`
   * to THIS side at runtime — the mirror image of the peer's own
   * `pushTopics`/`allowDynamicSubscribe` (see #handleSubscribeRequest()
   * above). Fire-and-forget from the caller's perspective — there's no
   * response to await; the peer either starts pushing matching qubits from
   * now on, or (disallowed by its own policy) silently doesn't. ACL still
   * gates what's actually delivered either way, so a rejected/ignored
   * subscribe() is not a security-relevant outcome, just "no live data".
   */
  async subscribe(topic) {
    await this.#channel.send({ type: "qu.subscribe", topic: String(topic) });
  }
  /**
   * The "I'm about to actively care about this topic" convenience: pulls
   * whatever already exists (sync() — bidirectional, and already
   * incremental via its own `since` cursor, so this is cheap to call
   * repeatedly), THEN registers for live delivery going forward
   * (subscribe()). This is what QuSpace's on()/map() trigger once, at
   * listener-activation time, when a network plugin is installed — see
   * core/space-handle.js's subscribeDispatch and README's network section.
   */
  async ensureSynced(topic, opts) {
    await this.sync({ topic, ...opts });
    await this.subscribe(topic);
  }
  listen() {
  }
  get peerFingerprint() {
    return this.#peerFingerprint;
  }
  get channelId() {
    return this.#channelId;
  }
  close() {
    this.#off();
    if (this.#offPush) this.#offPush();
    if (this.#router) this.#router.removeRoute(this.#channelId);
  }
};

// src/network/index.js
function createNetworkPlugin() {
  let router = null;
  function getRouter() {
    if (!router) router = new Router();
    return router;
  }
  const activeRepls = /* @__PURE__ */ new Set();
  return {
    install(qu) {
      qu.connect = async (channel, {
        pushTopics = [],
        subscribeOwnSpace = true,
        role = null,
        group = null,
        metric = 0,
        requireDirectWriter = false,
        rateLimiter = null,
        ingestGate = [],
        allowDynamicSubscribe = false,
        maxDynamicTopics = 200
      } = {}) => {
        const peerFingerprint = await authenticateChannel(channel, qu.identity);
        const repl = new DefaultReplication(qu.runtime, channel, {
          getACL: qu.acl,
          peerFingerprint,
          pushTopics,
          router: role ? getRouter() : null,
          requireDirectWriter,
          rateLimiter,
          ingestGate,
          allowDynamicSubscribe,
          maxDynamicTopics
        });
        activeRepls.add(repl);
        channel.onClose(() => activeRepls.delete(repl));
        if (role) getRouter().addRoute({ channelId: repl.channelId, channel, pushTopics, role, group, metric, peerFingerprint });
        if (subscribeOwnSpace && qu.userSpaceId) {
          repl.subscribe(qu.userSpaceId).catch((e) => console.error("[Network] subscribeOwnSpace fehlgeschlagen:", e));
        }
        return repl;
      };
      Object.defineProperty(qu, "router", { get: getRouter, configurable: true });
      qu.setSubscribeHandler(async (session, topic) => {
        await Promise.all([...activeRepls].map((repl) => repl.ensureSynced(topic).catch((e) => console.error(`[Network] ensureSynced("${topic}") fehlgeschlagen:`, e))));
      });
    }
  };
}

// src/network/routed-events.js
function sendRoutedEvent(channel, toFingerprint, event, payload) {
  return channel.send({ type: "qu.route", to: toFingerprint, event, payload });
}
function onRoutedEvent(channel, event, callback) {
  return channel.onMessage((msg) => {
    if (msg.type === "qu.route" && msg.event === event) callback(msg);
  });
}

// src/network/transports/webrtc-browser.js
var DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
function isPolite(myFingerprint, peerFingerprint) {
  return myFingerprint < peerFingerprint;
}
function candidateType(candidate) {
  if (!candidate) return null;
  if (candidate.type) return candidate.type;
  const m = /\btyp (\w+)/.exec(candidate.candidate ?? "");
  return m ? m[1] : "unknown";
}
function isIPv6Candidate(candidate) {
  const address = candidate?.address ?? candidate?.candidate?.split(" ")?.[4];
  return typeof address === "string" && address.includes(":");
}
function createWebRTCChannel({
  signalingChannel,
  myFingerprint,
  peerFingerprint,
  iceServers = DEFAULT_ICE_SERVERS,
  initialSignals = [],
  // Wer erzeugt proaktiv den Datenkanal (und löst damit die erste
  // Aushandlung aus)? Per Default die Fingerprint-Regel (Perfect
  // Negotiation, für den unkoordinierten Fall: beide Seiten rufen
  // z. B. gleichzeitig connectDirect() auf, ohne voneinander zu wissen —
  // deterministisch anhand der Fingerprints, damit nicht beide einen
  // Datenkanal aufmachen). ABER: kennt der Aufrufer die Rollen bereits
  // eindeutig (z. B. PeerConnectionManager: "ich rufe selbst
  // connectDirect() auf" vs. "ich reagiere auf ein bereits eingetroffenes
  // Signal"), MUSS das Vorrang vor der Fingerprint-Regel haben — sonst
  // kann die aufrufende Seite per Fingerprint zufällig "polite" sein,
  // selbst nie proaktiv verbinden UND die Gegenseite (die rein reaktiv
  // ist und nie selbst initiiert) ewig auf ein Signal warten lassen, das
  // nie kommt (stiller Deadlock, ca. 50% der Anrufe je nach
  // Fingerprint-Zufall).
  initiator = null
} = {}) {
  const polite = isPolite(myFingerprint, peerFingerprint);
  const shouldCreateDataChannel = initiator === null ? !polite : initiator;
  const pc = new RTCPeerConnection({ iceServers });
  let ipv4OnlyMode = false;
  let ipv4FallbackAttempted = false;
  let sawIPv6Candidate = false;
  let dc = null;
  let closed = false;
  let makingOffer = false;
  let ignoreOffer = false;
  const messageListeners = /* @__PURE__ */ new Set();
  const closeListeners = /* @__PURE__ */ new Set();
  let pending = [];
  let openResolve;
  let openReject;
  const openPromise = new Promise((res, rej) => {
    openResolve = res;
    openReject = rej;
  });
  const dispatch = (obj) => {
    if (messageListeners.size === 0) {
      pending.push(obj);
      return;
    }
    messageListeners.forEach((fn) => {
      try {
        fn(obj);
      } catch (e) {
        console.error("[webrtc-channel] listener error:", e);
      }
    });
  };
  function wireDataChannel(channel) {
    dc = channel;
    dc.onopen = () => {
      debug("webrtc", "datachannel-open", { peerFingerprint });
      openResolve();
    };
    dc.onclose = () => {
      debug("webrtc", "datachannel-close", { peerFingerprint });
      fireClose();
    };
    dc.onerror = (ev) => debug("webrtc", "datachannel-error", { peerFingerprint, error: ev?.error?.message ?? String(ev) });
    dc.onmessage = (ev) => {
      let obj;
      try {
        obj = JSON.parse(ev.data);
      } catch (e) {
        debug("webrtc", "parse-error", { peerFingerprint, error: e.message });
        return;
      }
      debug("webrtc", "message-in", { peerFingerprint, type: obj?.type });
      dispatch(obj);
    };
  }
  function fireClose() {
    if (closed) return;
    closed = true;
    openReject?.(new Error("[webrtc-channel] closed before opening"));
    closeListeners.forEach((fn) => fn());
  }
  debug("webrtc", "channel-init", { peerFingerprint, polite, shouldCreateDataChannel, initialSignalCount: initialSignals.length, iceServerCount: iceServers.length });
  if (shouldCreateDataChannel) wireDataChannel(pc.createDataChannel("qu"));
  pc.ondatachannel = (ev) => {
    if (!shouldCreateDataChannel) wireDataChannel(ev.channel);
  };
  async function handleSignal(msg) {
    if (msg.from !== peerFingerprint) return;
    const sdpType = msg.payload?.kind === "sdp" ? msg.payload.data?.type : void 0;
    debug("webrtc", "signal-received", { peerFingerprint, kind: msg.payload?.kind, sdpType, signalingState: pc.signalingState });
    try {
      if (msg.payload.kind === "sdp") {
        const description = msg.payload.data;
        const offerCollision = description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
        ignoreOffer = !polite && offerCollision;
        if (ignoreOffer) {
          debug("webrtc", "offer-ignored-glare", { peerFingerprint });
          return;
        }
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          debug("webrtc", "signal-sent", { peerFingerprint, kind: "sdp", sdpType: pc.localDescription.type });
          await sendRoutedEvent(signalingChannel, peerFingerprint, "webrtc-signal", { kind: "sdp", data: pc.localDescription });
        }
      } else if (msg.payload.kind === "ice") {
        try {
          await pc.addIceCandidate(msg.payload.data);
          debug("webrtc", "remote-ice-applied", { peerFingerprint, candidateType: candidateType(msg.payload.data) });
        } catch (e) {
          debug("webrtc", "remote-ice-error", { peerFingerprint, error: e.message, ignoreOffer });
          if (!ignoreOffer) throw e;
        }
      }
    } catch (e) {
      debug("webrtc", "signal-handling-error", { peerFingerprint, error: e.message });
      console.error("[webrtc-channel] error handling signal:", e);
    }
  }
  let signalChain = Promise.resolve();
  function enqueueSignal(msg) {
    signalChain = signalChain.then(() => handleSignal(msg));
  }
  const offSignal = onRoutedEvent(signalingChannel, "webrtc-signal", (msg) => {
    enqueueSignal(msg);
  });
  for (const sig of initialSignals) enqueueSignal(sig);
  pc.onnegotiationneeded = async () => {
    debug("webrtc", "negotiation-needed", { peerFingerprint, signalingState: pc.signalingState });
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      debug("webrtc", "signal-sent", { peerFingerprint, kind: "sdp", sdpType: pc.localDescription.type });
      await sendRoutedEvent(signalingChannel, peerFingerprint, "webrtc-signal", { kind: "sdp", data: pc.localDescription });
    } catch (e) {
      debug("webrtc", "negotiation-error", { peerFingerprint, error: e.message });
    } finally {
      makingOffer = false;
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    const isIPv6 = isIPv6Candidate(candidate);
    if (isIPv6) sawIPv6Candidate = true;
    debug("webrtc", "local-ice-candidate", { peerFingerprint, candidateType: candidateType(candidate), protocol: candidate.protocol, isIPv6 });
    if (ipv4OnlyMode && isIPv6) return;
    sendRoutedEvent(signalingChannel, peerFingerprint, "webrtc-signal", { kind: "ice", data: candidate });
  };
  pc.onicecandidateerror = (ev) => {
    debug("webrtc", "ice-candidate-error", { peerFingerprint, errorCode: ev.errorCode, errorText: ev.errorText, url: ev.url, address: ev.address, port: ev.port });
  };
  pc.onicegatheringstatechange = () => {
    debug("webrtc", "ice-gathering-state", { peerFingerprint, state: pc.iceGatheringState });
  };
  pc.oniceconnectionstatechange = () => {
    debug("webrtc", "ice-connection-state", { peerFingerprint, state: pc.iceConnectionState });
  };
  pc.onsignalingstatechange = () => {
    debug("webrtc", "signaling-state", { peerFingerprint, state: pc.signalingState });
  };
  pc.onconnectionstatechange = () => {
    debug("webrtc", "connection-state", { peerFingerprint, state: pc.connectionState });
    if (pc.connectionState === "failed") {
      if (!ipv4FallbackAttempted && sawIPv6Candidate) {
        ipv4FallbackAttempted = true;
        ipv4OnlyMode = true;
        debug("webrtc", "ipv4-fallback-retry", { peerFingerprint });
        try {
          pc.restartIce();
        } catch (e) {
          debug("webrtc", "ipv4-fallback-restart-error", { peerFingerprint, error: e.message });
          fireClose();
        }
        return;
      }
      fireClose();
    } else if (pc.connectionState === "closed") {
      fireClose();
    }
  };
  return {
    id: `webrtc:${peerFingerprint}`,
    async connect() {
      await openPromise;
    },
    async send(obj) {
      if (closed || !dc || dc.readyState !== "open") return;
      debug("webrtc", "message-out", { peerFingerprint, type: obj?.type });
      dc.send(JSON.stringify(obj));
    },
    onMessage(fn) {
      messageListeners.add(fn);
      if (pending.length) {
        const buffered = pending;
        pending = [];
        for (const obj of buffered) messageListeners.forEach((f) => f(obj));
      }
      return () => messageListeners.delete(fn);
    },
    onClose(fn) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    async close() {
      if (closed) return;
      closed = true;
      offSignal();
      dc?.close();
      pc.close();
      closeListeners.forEach((fn) => fn());
    },
    // Fluchttüren für PeerConnectionManager (Metrik-Sampling via getStats(),
    // spätere A/V-Erweiterung) — nicht Teil des Channel-Contracts selbst.
    get peerConnection() {
      return pc;
    },
    get connectionState() {
      return pc.connectionState;
    }
  };
}

// src/network/webrtc-peer-manager.js
var PeerConnectionManager = class {
  #qu;
  #router;
  #signalingChannel;
  #connections = /* @__PURE__ */ new Map();
  // peerFingerprint -> { channel, repl }
  #pendingIncoming = /* @__PURE__ */ new Set();
  // peerFingerprint, während #onIncomingConnection()/#establish() noch laufen (siehe #handleIncoming())
  #pendingOutgoing = /* @__PURE__ */ new Set();
  // peerFingerprint, während UNSERE eigene connectDirect()/#establish() noch läuft (siehe #handleIncoming())
  #pendingSignals = /* @__PURE__ */ new Map();
  // peerFingerprint -> msg[], siehe #handleIncoming()s Zwischenspeicherung während des Klingelns
  #offIncoming;
  #onIncomingConnection;
  #connectListeners = /* @__PURE__ */ new Set();
  #connectFailedListeners = /* @__PURE__ */ new Set();
  #iceServers;
  /**
   * `onIncomingConnection(peerFingerprint)`: optionaler Hook, wird
   * aufgerufen, wenn jemand uns unaufgefordert kontaktiert (Signaling-
   * Nachricht von einem Fingerprint, zu dem wir noch keine Verbindung
   * haben). Rückgabe `{ pushTopics, group?, metric? }` nimmt an — `null`/
   * `undefined` lehnt die Verbindung ab (es wird einfach keine
   * WebRTCChannel für sie erzeugt). Ohne Hook: alle eingehenden
   * Verbindungen werden mit `pushTopics: []` angenommen (Kanal steht,
   * repliziert aber nichts, bis die App das explizit konfiguriert) —
   * sicherer Default, kein automatisches Datenteilen mit Unbekannten.
   *
   * `iceServers`: passed straight through to every RTCPeerConnection this
   * manager creates (createWebRTCChannel()'s own `iceServers`) —
   * `undefined` keeps that function's STUN-only default.
   */
  constructor(qu, { router = null, signalingChannel, onIncomingConnection = null, iceServers } = {}) {
    this.#qu = qu;
    this.#router = router;
    this.#signalingChannel = signalingChannel;
    this.#onIncomingConnection = onIncomingConnection ?? (async () => ({ pushTopics: [] }));
    this.#iceServers = iceServers;
    this.#offIncoming = signalingChannel.onMessage((msg) => this.#handleIncoming(msg));
  }
  async #handleIncoming(msg) {
    if (msg.type !== "qu.route" || msg.event !== "webrtc-signal" || !msg.from) return;
    debug("webrtc-pm", "incoming-signal", { from: msg.from, kind: msg.payload?.kind, alreadyConnected: this.#connections.has(msg.from), alreadyPending: this.#pendingIncoming.has(msg.from), ownOutgoingInFlight: this.#pendingOutgoing.has(msg.from) });
    if (this.#connections.has(msg.from)) return;
    if (this.#pendingOutgoing.has(msg.from)) return;
    if (this.#pendingIncoming.has(msg.from)) {
      this.#pendingSignals.get(msg.from)?.push(msg);
      return;
    }
    this.#pendingIncoming.add(msg.from);
    this.#pendingSignals.set(msg.from, []);
    try {
      const opts = await this.#onIncomingConnection(msg.from);
      if (!opts) {
        debug("webrtc-pm", "incoming-declined", { from: msg.from });
        return;
      }
      const buffered = this.#pendingSignals.get(msg.from) ?? [];
      debug("webrtc-pm", "incoming-accepted", { from: msg.from, bufferedSignalCount: buffered.length });
      await this.#establish(msg.from, { ...opts, initialSignals: [msg, ...buffered] });
    } catch (e) {
      debug("webrtc-pm", "incoming-failed", { from: msg.from, error: e.message });
      console.error("[PeerConnectionManager] incoming connection failed:", e);
      this.#connectFailedListeners.forEach((fn) => {
        try {
          fn(msg.from, e);
        } catch (listenerErr) {
          console.error("[PeerConnectionManager] onConnectFailed listener error:", listenerErr);
        }
      });
    } finally {
      this.#pendingIncoming.delete(msg.from);
      this.#pendingSignals.delete(msg.from);
    }
  }
  /** Baut (falls noch nicht vorhanden) eine Direktverbindung zu `peerFingerprint` auf und registriert sie im Router. */
  async connectDirect(peerFingerprint, opts = {}) {
    debug("webrtc-pm", "connect-direct", { peerFingerprint, alreadyConnected: this.#connections.has(peerFingerprint) });
    if (this.#connections.has(peerFingerprint)) return this.#connections.get(peerFingerprint);
    return this.#establish(peerFingerprint, opts);
  }
  async #establish(peerFingerprint, { pushTopics = [], group = `peer:${peerFingerprint}`, metric = 10, initialSignals = [] } = {}) {
    const isOutgoing = initialSignals.length === 0;
    if (isOutgoing) this.#pendingOutgoing.add(peerFingerprint);
    try {
      debug("webrtc-pm", "establish-start", { peerFingerprint, initiator: isOutgoing, initialSignalCount: initialSignals.length });
      const channel = createWebRTCChannel({
        signalingChannel: this.#signalingChannel,
        myFingerprint: this.#qu.fingerprint,
        peerFingerprint,
        initialSignals,
        iceServers: this.#iceServers,
        // #establish() weiß hier eindeutig, welche Rolle diese Seite hat:
        // OHNE initialSignals ruft DIESE Seite gerade selbst connectDirect()
        // auf (= Initiator), MIT initialSignals reagieren wir auf bereits
        // eingetroffene Signale der Gegenseite (= die Gegenseite hat längst
        // initiiert). Siehe createWebRTCChannel()s initiator-Doku für die
        // Fingerprint-Zufalls-Falle, die das vermeidet.
        initiator: isOutgoing
      });
      await channel.connect();
      debug("webrtc-pm", "establish-datachannel-open", { peerFingerprint });
      const provenFp = await authenticateChannel(channel, this.#qu.identity);
      debug("webrtc-pm", "establish-handshake-done", { peerFingerprint, provenFp, matches: provenFp === peerFingerprint });
      if (provenFp !== peerFingerprint) {
        channel.close();
        throw new Error(`[PeerConnectionManager] Handshake-Mismatch: erwartet ${peerFingerprint}, bewiesen wurde ${provenFp}`);
      }
      debug("webrtc-pm", "verified", { peerFingerprint });
      const repl = new DefaultReplication(this.#qu.runtime, channel, {
        pushTopics,
        peerFingerprint,
        router: this.#router
      });
      if (this.#router) {
        this.#router.addRoute({
          channelId: repl.channelId,
          channel,
          pushTopics,
          role: "sync",
          group,
          metric,
          transport: "webrtc",
          peerFingerprint
        });
      }
      const entry = { channel, repl };
      this.#connections.set(peerFingerprint, entry);
      channel.onClose(() => {
        repl.close();
        this.#connections.delete(peerFingerprint);
        debug("webrtc-pm", "disconnected", { peerFingerprint });
      });
      this.#connectListeners.forEach((fn) => {
        try {
          fn(peerFingerprint, entry);
        } catch (e) {
          console.error("[PeerConnectionManager] onConnect listener error:", e);
        }
      });
      return entry;
    } finally {
      if (isOutgoing) this.#pendingOutgoing.delete(peerFingerprint);
    }
  }
  /** `callback(peerFingerprint, { channel, repl })` — feuert für JEDE erfolgreich aufgebaute Verbindung, ausgehend über connectDirect() oder eingehend, ohne dass Aufrufer beide Fälle getrennt behandeln müssen. */
  onConnect(callback) {
    this.#connectListeners.add(callback);
    return () => this.#connectListeners.delete(callback);
  }
  /**
   * `callback(peerFingerprint, error)` — feuert, wenn eine EINGEHENDE
   * Verbindung (jemand kontaktiert uns, #handleIncoming()) fehlschlägt,
   * z. B. weil kein P2P-Pfad zustande kommt (fehlender TURN-Server hinter
   * NAT). Für eine SELBST per connectDirect() angestoßene Verbindung
   * braucht es das nicht — deren Promise lehnt sich direkt beim Aufrufer
   * ab. Ohne dieses Gegenstück hätte die rein reaktive Seite gar keine
   * Möglichkeit, je von einem gescheiterten Aufbau zu erfahren.
   */
  onConnectFailed(callback) {
    this.#connectFailedListeners.add(callback);
    return () => this.#connectFailedListeners.delete(callback);
  }
  disconnect(peerFingerprint) {
    this.#connections.get(peerFingerprint)?.channel.close();
  }
  get(peerFingerprint) {
    return this.#connections.get(peerFingerprint) ?? null;
  }
  get connectedFingerprints() {
    return [...this.#connections.keys()];
  }
  close() {
    this.#offIncoming();
    for (const fp of this.connectedFingerprints) this.disconnect(fp);
  }
};

// src/network/webrtc-plugin.js
function createWebRTCPlugin() {
  return {
    install(qu) {
      if (!("router" in qu)) {
        throw new Error("[WebRTC] createWebRTCPlugin() braucht createNetworkPlugin() f\xFCr den gemeinsamen Router \u2014 zuerst qu.use(createNetworkPlugin()) aufrufen.");
      }
      qu.webrtc = (signalingChannel, opts = {}) => new PeerConnectionManager(qu, { router: qu.router, signalingChannel, ...opts });
    }
  };
}

// src/presets.js
var QU_PRESETS = {
  get local() {
    return [];
  },
  get spaces() {
    return [createSpacesPlugin()];
  },
  get network() {
    return [createSpacesPlugin(), createNetworkPlugin()];
  },
  get networkWebRTC() {
    return [createSpacesPlugin(), createNetworkPlugin(), createWebRTCPlugin()];
  }
};

// src/adapters/null.js
var NullAdapter = class {
  async get() {
    return null;
  }
  async put() {
  }
  async delete() {
  }
  async getAll() {
    return [];
  }
};

// src/adapters/file-storage-memory.js
var MemoryFileStorageAdapter = class {
  #chunks = /* @__PURE__ */ new Map();
  async putChunk(hash, bytes) {
    this.#chunks.set(hash, bytes);
  }
  async getChunk(hash) {
    return this.#chunks.get(hash) ?? null;
  }
  async hasChunk(hash) {
    return this.#chunks.has(hash);
  }
  async deleteChunk(hash) {
    this.#chunks.delete(hash);
  }
};

// src/adapters/indexeddb-file-storage.js
var STORE = "chunks";
function openDB(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
var IndexedDBFileStorageAdapter = class {
  #ready;
  constructor({ dbName = "qu-files" } = {}) {
    this.#ready = openDB(dbName);
  }
  async #store(mode) {
    const db = await this.#ready;
    return db.transaction(STORE, mode).objectStore(STORE);
  }
  async putChunk(hash, bytes) {
    await wrap((await this.#store("readwrite")).put(bytes, hash));
  }
  /**
   * Writes many chunks in ONE transaction instead of one per chunk — an
   * optional extension beyond FileStorageAdapter's required four methods
   * (contract.js), detected/used by data/files/manifest.js's publishFile()
   * when present, silently unused (per-chunk putChunk() stays correct,
   * just slower) by any adapter that doesn't implement it. Matters a lot
   * here specifically: EVERY IndexedDB transaction has real commit
   * overhead (the browser flushes it before resolving), so publishing a
   * large file (a video: thousands of 64 KiB chunks at the default
   * DEFAULT_CHUNK_SIZE) one `putChunk()` at a time paid that overhead
   * thousands of times — measured as minutes for a file that should take
   * seconds, which looked exactly like "video upload just hangs, no
   * visible progress" from the UI (each chunk's progress tick was real,
   * just each one was agonizingly slow to land). Batching drops the
   * transaction count by `entries.length`, typically 32-64x fewer commits
   * for the same file.
   */
  async putChunks(entries) {
    if (!entries.length) return;
    const store = await this.#store("readwrite");
    await new Promise((resolve, reject) => {
      const tx = store.transaction;
      for (const { hash, bytes } of entries) store.put(bytes, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("[IndexedDBFileStorageAdapter] putChunks() transaction aborted"));
    });
  }
  async getChunk(hash) {
    const result = await wrap((await this.#store("readonly")).get(hash));
    return result ?? null;
  }
  async hasChunk(hash) {
    const count = await wrap((await this.#store("readonly")).count(hash));
    return count > 0;
  }
  async deleteChunk(hash) {
    await wrap((await this.#store("readwrite")).delete(hash));
  }
};

// src/adapters/local-storage.js
var LocalStorageAdapter = class {
  #storage;
  #ns;
  constructor({ namespace = "qu:" } = {}) {
    this.#storage = localStorage;
    this.#ns = namespace;
  }
  async get(id) {
    const raw = this.#storage.getItem(this.#ns + id);
    return raw === null ? null : JSON.parse(raw);
  }
  async put(id, q) {
    this.#storage.setItem(this.#ns + id, JSON.stringify(q));
  }
  async delete(id) {
    this.#storage.removeItem(this.#ns + id);
  }
  async getAll(prefix = "") {
    const out = [];
    const full = this.#ns + prefix;
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(full)) out.push(JSON.parse(this.#storage.getItem(key)));
    }
    return out;
  }
  /** Only this adapter's own namespace — other localStorage keys on the same origin are left untouched. */
  async clear() {
    const toRemove = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(this.#ns)) toRemove.push(key);
    }
    toRemove.forEach((k) => this.#storage.removeItem(k));
  }
};

// src/adapters/session-storage.js
var SessionStorageAdapter = class {
  #storage;
  #ns;
  constructor({ namespace = "qu:" } = {}) {
    this.#storage = sessionStorage;
    this.#ns = namespace;
  }
  async get(id) {
    const raw = this.#storage.getItem(this.#ns + id);
    return raw === null ? null : JSON.parse(raw);
  }
  async put(id, q) {
    this.#storage.setItem(this.#ns + id, JSON.stringify(q));
  }
  async delete(id) {
    this.#storage.removeItem(this.#ns + id);
  }
  async getAll(prefix = "") {
    const out = [];
    const full = this.#ns + prefix;
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(full)) out.push(JSON.parse(this.#storage.getItem(key)));
    }
    return out;
  }
  async clear() {
    const toRemove = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(this.#ns)) toRemove.push(key);
    }
    toRemove.forEach((k) => this.#storage.removeItem(k));
  }
};

// src/adapters/indexeddb.js
var STORE2 = "qubits";
function openDB2(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE2, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function rangeFor(prefix) {
  if (!prefix) return void 0;
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return IDBKeyRange.bound(prefix, upper, false, true);
}
function wrap2(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
var IndexedDBAdapter = class {
  #ready;
  constructor({ dbName = "qu" } = {}) {
    this.#ready = openDB2(dbName);
  }
  async #store(mode) {
    const db = await this.#ready;
    return db.transaction(STORE2, mode).objectStore(STORE2);
  }
  async get(id) {
    const result = await wrap2((await this.#store("readonly")).get(id));
    return result ?? null;
  }
  async put(id, q) {
    await wrap2((await this.#store("readwrite")).put(q));
  }
  async delete(id) {
    await wrap2((await this.#store("readwrite")).delete(id));
  }
  async getAll(prefix = "") {
    const store = await this.#store("readonly");
    return new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor(rangeFor(prefix));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
  async clear() {
    await wrap2((await this.#store("readwrite")).clear());
  }
};

// src/network/transports/websocket-browser.js
function createWebSocketChannel(url) {
  let ws = null;
  let closed = false;
  const messageListeners = /* @__PURE__ */ new Set();
  const closeListeners = /* @__PURE__ */ new Set();
  let pending = [];
  const dispatch = (obj) => {
    if (messageListeners.size === 0) {
      pending.push(obj);
      return;
    }
    messageListeners.forEach((fn) => safeInvoke(fn, obj, "ws-client"));
  };
  return {
    id: `ws-client-${Math.random().toString(36).slice(2)}`,
    connect() {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(url);
        ws.addEventListener("open", () => {
          debug("ws-client", "open", { url });
          resolve();
        }, { once: true });
        ws.addEventListener("error", (e) => reject(new Error(`[WebSocketChannel] connection failed: ${e.message || "unknown error"}`)), { once: true });
        ws.addEventListener("message", (ev) => {
          let obj;
          try {
            obj = JSON.parse(ev.data);
          } catch (e) {
            debug("ws-client", "parse-error", { error: e.message });
            return;
          }
          debug("ws-client", "message-in", { type: obj?.type, bytes: ev.data.length });
          dispatch(obj);
        });
        ws.addEventListener("close", () => {
          closed = true;
          debug("ws-client", "close", { url });
          closeListeners.forEach((fn) => fn());
        });
      });
    },
    async send(obj) {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      debug("ws-client", "message-out", { type: obj?.type });
      ws.send(JSON.stringify(obj));
    },
    /** Proactive check, not just reacting to the 'close' event — a mobile OS can drop a background connection well before the browser notices/fires close. */
    isOpen() {
      return !closed && !!ws && ws.readyState === WebSocket.OPEN;
    },
    // See relay/ws-server.mjs for why this buffers instead of dropping.
    onMessage(fn) {
      messageListeners.add(fn);
      if (pending.length) {
        const buffered = pending;
        pending = [];
        for (const obj of buffered) messageListeners.forEach((f) => safeInvoke(f, obj, "ws-client"));
      }
      return () => messageListeners.delete(fn);
    },
    onClose(fn) {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    async close() {
      if (!closed) {
        closed = true;
        ws?.close();
      }
    }
  };
}

// src/data/files/contract.js
function assertFileStorageAdapter(adapter) {
  const required = ["putChunk", "getChunk", "hasChunk", "deleteChunk"];
  for (const m of required) {
    if (typeof adapter[m] !== "function") {
      throw new Error(`[FileStorageAdapter] Object does not satisfy the FileStorageAdapter contract: missing "${m}"`);
    }
  }
  return adapter;
}

// src/data/files/manifest.js
var DEFAULT_CHUNK_SIZE = 64 * 1024;
var YIELD_EVERY_N_CHUNKS = 8;
var WRITE_BATCH_SIZE = 32;
function splitChunks(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  if (bytes.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
}
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function publishFile(session, id, bytes, { name, mime = "application/octet-stream", chunkSize = DEFAULT_CHUNK_SIZE, fileStorage, refs, encryptFor: encryptFor2, onProgress } = {}) {
  if (!fileStorage) throw new Error("[publishFile] fileStorage (a FileStorageAdapter) is required");
  assertFileStorageAdapter(fileStorage);
  let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const plainSize = data.length;
  let contentEncryption;
  let metaEncryption;
  if (encryptFor2 && encryptFor2.length) {
    onProgress?.({ phase: "encrypting" });
    const recipients = await session.resolveEncryptionRecipients(encryptFor2);
    const { envelope, ciphertext } = await encryptBytesFor(recipients, data);
    contentEncryption = envelope;
    data = ciphertext;
    metaEncryption = await encryptFor(recipients, { name, mime, size: plainSize });
  }
  const chunks = splitChunks(data, chunkSize);
  debug("files", "chunking-start", { id, size: data.length, chunkCount: chunks.length, encrypted: !!contentEncryption });
  onProgress?.({ phase: "chunking", done: 0, total: chunks.length });
  const hashes = [];
  const supportsBatch = typeof fileStorage.putChunks === "function";
  let writeBatch = [];
  for (let i = 0; i < chunks.length; i++) {
    const hash = await sha256Hex(chunks[i]);
    hashes.push(hash);
    const stored = chunks[i].slice();
    if (supportsBatch) {
      writeBatch.push({ hash, bytes: stored });
      if (writeBatch.length >= WRITE_BATCH_SIZE || i === chunks.length - 1) {
        await fileStorage.putChunks(writeBatch);
        writeBatch = [];
      }
    } else {
      await fileStorage.putChunk(hash, stored);
    }
    onProgress?.({ phase: "chunking", done: i + 1, total: chunks.length });
    if (i % YIELD_EVERY_N_CHUNKS === 0) await yieldToEventLoop();
  }
  const manifest = { chunkSize, chunks: hashes };
  if (contentEncryption) {
    manifest.contentEncryption = contentEncryption;
    manifest.metaEncryption = metaEncryption;
  } else {
    manifest.name = name;
    manifest.mime = mime;
    manifest.size = plainSize;
  }
  const result = await session.publish(id, manifest, { refs, encryptFor: null });
  debug("files", "chunking-complete", { id, chunkCount: chunks.length });
  return { manifestId: id, manifest, ...result };
}
async function readFileMeta(manifest, identity = null) {
  if (!manifest.metaEncryption) return { name: manifest.name, mime: manifest.mime, size: manifest.size };
  if (!identity) throw new Error("[readFileMeta] this file's metadata is encrypted (manifest.metaEncryption) \u2014 an identity is required to decrypt it");
  return decryptWith(identity, manifest.metaEncryption);
}
async function reassembleFile(fileStorage, manifest, identity = null) {
  const parts = [];
  let total = 0;
  for (const hash of manifest.chunks) {
    const chunk = await fileStorage.getChunk(hash);
    if (!chunk) return null;
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  if (!manifest.contentEncryption) return out;
  if (!identity) throw new Error("[reassembleFile] this file is encrypted (manifest.contentEncryption) \u2014 an identity is required to decrypt it");
  return decryptBytesWith(identity, manifest.contentEncryption, out);
}
async function missingChunks(fileStorage, manifest) {
  const missing = [];
  for (const hash of manifest.chunks) {
    if (!await fileStorage.hasChunk(hash)) missing.push(hash);
  }
  return missing;
}

// src/data/files/transfer.js
var DefaultFileTransfer = class {
  #runtime;
  #channel;
  #fileStorage;
  #getACL;
  #peerFingerprint;
  #pending = /* @__PURE__ */ new Map();
  #reqId = 0;
  #off;
  constructor(runtime, channel, fileStorage, { getACL = async () => null, peerFingerprint = null } = {}) {
    this.#runtime = runtime;
    this.#channel = assertChannel(channel);
    this.#fileStorage = assertFileStorageAdapter(fileStorage);
    this.#getACL = getACL;
    this.#peerFingerprint = peerFingerprint;
    this.#off = channel.onMessage((msg) => this.#handleMessage(msg));
  }
  async #isManifestVisible(qubit) {
    if (!qubit) return false;
    const [visible] = await filterForReader([qubit], this.#peerFingerprint, this.#getACL);
    return !!visible;
  }
  async #handleMessage(msg) {
    if (msg.type === "qu.file.manifest.request") {
      const qubit = await this.#runtime.get(msg.manifestId);
      const visible = await this.#isManifestVisible(qubit);
      debug("files", "manifest-request", { manifestId: msg.manifestId, found: !!qubit, visible });
      await this.#channel.send({ type: "qu.file.manifest.response", reqId: msg.reqId, qubit: visible ? qubit : null });
      return;
    }
    if (msg.type === "qu.file.chunk.request") {
      const manifestQ = await this.#runtime.get(msg.manifestId);
      const belongsToManifest = manifestQ?.value?.chunks?.includes(msg.hash);
      const allowed = belongsToManifest && await this.#isManifestVisible(manifestQ);
      const bytes = allowed && await this.#fileStorage.hasChunk(msg.hash) ? await this.#fileStorage.getChunk(msg.hash) : null;
      debug("files", "chunk-request", { manifestId: msg.manifestId, hash: msg.hash, allowed, have: !!bytes });
      await this.#channel.send({ type: "qu.file.chunk.response", reqId: msg.reqId, hash: msg.hash, bytes: bytes ? toB64(bytes) : null });
      return;
    }
    if (msg.type === "qu.file.readiness.request") {
      const manifestQ = await this.#runtime.get(msg.manifestId);
      const visible = await this.#isManifestVisible(manifestQ);
      let ready = false;
      if (visible && manifestQ) {
        ready = true;
        for (const hash of manifestQ.value.chunks) {
          if (!await this.#fileStorage.hasChunk(hash)) {
            ready = false;
            break;
          }
        }
      }
      debug("files", "readiness-request", { manifestId: msg.manifestId, visible, ready });
      await this.#channel.send({ type: "qu.file.readiness.response", reqId: msg.reqId, ready });
      return;
    }
    const resolver = this.#pending.get(msg.reqId);
    if (resolver && (msg.type === "qu.file.manifest.response" || msg.type === "qu.file.chunk.response" || msg.type === "qu.file.readiness.response")) {
      this.#pending.delete(msg.reqId);
      resolver(msg);
    }
  }
  async #request(message, timeoutMs = 1e4) {
    const reqId = ++this.#reqId;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(reqId, resolve);
      setTimeout(() => {
        if (this.#pending.has(reqId)) {
          this.#pending.delete(reqId);
          reject(new Error("[DefaultFileTransfer] request timed out"));
        }
      }, timeoutMs);
    });
    await this.#channel.send({ ...message, reqId });
    return p;
  }
  async #ensureManifest(manifestId) {
    let qubit = await this.#runtime.get(manifestId);
    if (qubit) return qubit;
    const resp = await this.#request({ type: "qu.file.manifest.request", manifestId });
    if (!resp.qubit) throw new Error(`[DefaultFileTransfer] Peer has no manifest for ${manifestId}, or denied it`);
    await this.#runtime.ingest(resp.qubit);
    return this.#runtime.get(manifestId);
  }
  async requestFile(manifestId, { onProgress } = {}) {
    const qubit = await this.#ensureManifest(manifestId);
    const manifest = qubit.value;
    const missing = await missingChunks(this.#fileStorage, manifest);
    debug("files", "request-file", { manifestId, totalChunks: manifest.chunks.length, missing: missing.length });
    const maxAttempts = 6;
    for (const hash of missing) {
      let resp = null;
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          resp = await this.#request({ type: "qu.file.chunk.request", hash, manifestId });
          lastError = null;
        } catch (e) {
          lastError = e;
          resp = null;
        }
        if (resp?.bytes) break;
        debug("files", "chunk-not-ready", { manifestId, hash, attempt, maxAttempts, error: lastError?.message });
        onProgress?.({ attempt, maxAttempts, hash });
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
      if (!resp?.bytes) {
        throw new Error(`[DefaultFileTransfer] Chunk ${hash} still unavailable after ${maxAttempts} attempts \u2014 the sender may still be uploading, may have disconnected before finishing, or access was denied.`);
      }
      const bytes = fromB64(resp.bytes);
      const actualHash = await sha256Hex(bytes);
      if (actualHash !== hash) {
        debug("files", "chunk-integrity-failed", { manifestId, hash });
        throw new Error(`[DefaultFileTransfer] Chunk hash mismatch for ${hash} \u2014 rejected, not stored`);
      }
      await this.#fileStorage.putChunk(hash, bytes);
    }
    debug("files", "request-file-complete", { manifestId });
  }
  /**
   * Polls "do you have every chunk yet?" without downloading anything —
   * meant to run *before* requestFile(), so a UI can hold off offering (or
   * silently prepare) a download until it will actually succeed, instead
   * of a receiver clicking too early and requestFile() having to retry its
   * way through a real, if temporary, failure.
   */
  async waitUntilReady(manifestId, { intervalMs = 1e3, maxWaitMs = 3e4, onProgress } = {}) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      let ready = false;
      try {
        const resp = await this.#request({ type: "qu.file.readiness.request", manifestId });
        ready = !!resp.ready;
      } catch (e) {
        debug("files", "readiness-check-failed", { manifestId, attempt, error: e.message });
      }
      if (ready) {
        debug("files", "ready", { manifestId, attempt });
        return true;
      }
      onProgress?.({ attempt, elapsedMs: Date.now() - start });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }
  async hasComplete(manifestId) {
    const qubit = await this.#runtime.get(manifestId);
    if (!qubit) return false;
    const missing = await missingChunks(this.#fileStorage, qubit.value);
    return missing.length === 0;
  }
  close() {
    this.#off();
  }
};

// src/network/replication/hub.js
var ReplicationHub = class {
  #runtime;
  #getACL;
  #pushTopics;
  #identity;
  #fileStorage;
  #repls = /* @__PURE__ */ new Map();
  // channel.id -> DefaultReplication
  #transfers = /* @__PURE__ */ new Map();
  // channel.id -> DefaultFileTransfer
  #byFingerprint = /* @__PURE__ */ new Map();
  // fingerprint -> channel.id (last-attached wins for a given fingerprint)
  #requireDirectWriter;
  #rateLimiter;
  #ingestGate;
  #allowDynamicSubscribe;
  #maxDynamicTopics;
  constructor(runtime, {
    identity = null,
    getACL = async () => null,
    pushTopics = [],
    fileStorage = null,
    requireDirectWriter = false,
    rateLimiter = null,
    ingestGate = [],
    // See DefaultReplication's constructor doc — applied identically to
    // every channel this Hub attaches, same as requireDirectWriter/rateLimiter.
    allowDynamicSubscribe = false,
    maxDynamicTopics = 200
  } = {}) {
    this.#runtime = runtime;
    this.#identity = identity;
    this.#getACL = getACL;
    this.#pushTopics = pushTopics;
    this.#fileStorage = fileStorage;
    this.#requireDirectWriter = requireDirectWriter;
    this.#rateLimiter = rateLimiter;
    this.#ingestGate = ingestGate;
    this.#allowDynamicSubscribe = allowDynamicSubscribe;
    this.#maxDynamicTopics = maxDynamicTopics;
  }
  async attach(channel) {
    const peerFingerprint = await authenticateChannel(channel, this.#identity);
    const repl = new DefaultReplication(this.#runtime, channel, {
      getACL: this.#getACL,
      peerFingerprint,
      pushTopics: this.#pushTopics,
      requireDirectWriter: this.#requireDirectWriter,
      rateLimiter: this.#rateLimiter,
      ingestGate: this.#ingestGate,
      allowDynamicSubscribe: this.#allowDynamicSubscribe,
      maxDynamicTopics: this.#maxDynamicTopics
    });
    this.#repls.set(channel.id, repl);
    let fileTransfer = null;
    if (this.#fileStorage) {
      fileTransfer = new DefaultFileTransfer(this.#runtime, channel, this.#fileStorage, {
        getACL: this.#getACL,
        peerFingerprint
      });
      this.#transfers.set(channel.id, fileTransfer);
    }
    if (peerFingerprint) this.#byFingerprint.set(peerFingerprint, channel.id);
    channel.onClose(() => this.detach(channel.id));
    return { repl, fileTransfer, peerFingerprint };
  }
  detach(channelId) {
    const repl = this.#repls.get(channelId);
    if (repl) {
      repl.close();
      this.#repls.delete(channelId);
    }
    const xfer = this.#transfers.get(channelId);
    if (xfer) {
      xfer.close();
      this.#transfers.delete(channelId);
    }
    for (const [fp, id] of this.#byFingerprint) if (id === channelId) this.#byFingerprint.delete(fp);
  }
  get(channelId) {
    return { repl: this.#repls.get(channelId), fileTransfer: this.#transfers.get(channelId) };
  }
  /** The currently-connected channel for a given proven fingerprint, if any — e.g. "ask this specific uploader for their file's chunks". */
  getByFingerprint(fingerprint) {
    const channelId = this.#byFingerprint.get(fingerprint);
    return channelId ? this.get(channelId) : null;
  }
  get size() {
    return this.#repls.size;
  }
  async broadcastSync({ topic }) {
    const results = [];
    for (const repl of this.#repls.values()) results.push(repl.sync({ topic }));
    return Promise.all(results);
  }
};

// src/network/replication/provider.js
function assertReplicationProvider(p) {
  for (const m of ["sync", "repair", "snapshot", "listen"]) {
    if (typeof p[m] !== "function") {
      throw new Error(`[ReplicationProvider] Object does not satisfy the contract: missing "${m}"`);
    }
  }
  return p;
}

// src/network/rate-limiter.js
function createRateLimiter({ maxPerWindow = 100, windowMs = 1e3, maxTrackedKeys = 1e3 } = {}) {
  const hits = /* @__PURE__ */ new Map();
  return {
    /** true = allowed, false = this key is currently over its limit. */
    allow(key) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(key) ?? []).filter((t) => t >= cutoff);
      const allowed = timestamps.length < maxPerWindow;
      if (allowed) timestamps.push(now);
      hits.set(key, timestamps);
      if (hits.size > maxTrackedKeys) hits.delete(hits.keys().next().value);
      return allowed;
    }
  };
}

// src/data/references.js
var REF_RE = /^(obj|key|file):\/\/(.+)$/;
function isReference(value) {
  return typeof value === "string" && REF_RE.test(value);
}
function parseReference(ref) {
  const m = typeof ref === "string" ? ref.match(REF_RE) : null;
  if (!m) throw new Error(`[References] Not a obj://|key://|file:// reference: ${JSON.stringify(ref)}`);
  return { scheme: m[1], path: m[2] };
}
function objRef(path) {
  return `obj://${path}`;
}
function keyRef(path) {
  return `key://${path}`;
}
function fileRef(manifestId) {
  return `file://${manifestId}`;
}
function lastSegment(id, prefix) {
  return id.slice(prefix.length).replace(/^\//, "").split("/")[0];
}
async function resolveOne(qu, ref, opts, seen, depth) {
  const { scheme, path } = parseReference(ref);
  if (scheme === "key") {
    const qubit2 = await qu.get(path);
    if (!qubit2) return void 0;
    return walk(qu, qubit2.value, opts, seen, depth - 1);
  }
  if (scheme === "obj") {
    const rows = await qu.session.query(`${path}/*`);
    const entries = await Promise.all(rows.map(async (q) => [
      lastSegment(q.id, path),
      await walk(qu, q.value, opts, seen, depth - 1)
    ]));
    if (opts.asArray) {
      return entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, v]) => v);
    }
    return Object.fromEntries(entries);
  }
  if (opts.fileHandler) return opts.fileHandler.resolveFileRef(qu, ref);
  const qubit = await qu.get(path);
  return qubit?.value;
}
async function walk(qu, value, opts, seen, depth) {
  if (isReference(value)) {
    if (depth <= 0 || seen.has(value)) return value;
    const nextSeen = new Set(seen);
    nextSeen.add(value);
    return resolveOne(qu, value, opts, nextSeen, depth);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => walk(qu, v, opts, seen, depth)));
  }
  if (value && typeof value === "object") {
    const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await walk(qu, v, opts, seen, depth)]));
    return Object.fromEntries(entries);
  }
  return value;
}
async function resolveReference(qu, ref, { maxDepth = 1, asArray = false, fileHandler } = {}) {
  return resolveOne(qu, ref, { asArray, fileHandler }, /* @__PURE__ */ new Set([ref]), maxDepth);
}
async function resolveValue(qu, value, { maxDepth = 1, asArray = false, fileHandler } = {}) {
  return walk(qu, value, { asArray, fileHandler }, /* @__PURE__ */ new Set(), maxDepth);
}
async function resolveKeyChain(session, id, { maxHops = 8 } = {}) {
  let current = String(id);
  const seen = /* @__PURE__ */ new Set();
  for (let hops = 0; hops <= maxHops; hops++) {
    if (seen.has(current)) {
      throw new Error(`[References] key://-Zyklus erkannt beim Aufl\xF6sen von "${id}" (erneut "${current}" erreicht) \u2014 eine Referenz zeigt direkt oder \xFCber mehrere Spr\xFCnge auf sich selbst.`);
    }
    seen.add(current);
    const qubit = await session.get(current);
    if (!qubit || !isReference(qubit.value)) return { id: current, qubit };
    const { scheme, path } = parseReference(qubit.value);
    if (scheme !== "key") return { id: current, qubit };
    current = path;
  }
  throw new Error(`[References] zu viele verkettete key://-Weiterleitungen beim Aufl\xF6sen von "${id}" (maxHops=${maxHops}) \u2014 m\xF6glicher Zyklus oder maxHops zu niedrig f\xFCr diese Anwendung.`);
}
function createReferenceHandlerPlugin({ maxDepth = 1, asArray = false, fileHandler, maxHops = 8 } = {}) {
  const defaults = { maxDepth, asArray, fileHandler };
  return {
    install(qu) {
      qu.resolveReference = (ref, opts) => resolveReference(qu, ref, { ...defaults, ...opts });
      qu.resolveValue = (value, opts) => resolveValue(qu, value, { ...defaults, ...opts });
      qu.setResolveHandler(async (session, id) => (await resolveKeyChain(session, id, { maxHops })).id);
    }
  };
}

// src/data/files/index.js
async function shareFile(qu, id, bytes, opts = {}) {
  if (qu.isGuest) throw new Error("[FileHandler] Guest-Sessions haben kein Schreibrecht (versucht: shareFile). Mit Qu.create({ identity }) eine echte Identit\xE4t verwenden.");
  const result = await publishFile(qu.session, id, bytes, opts);
  return { ...result, fileRef: fileRef(result.manifestId) };
}
async function resolveFileRef(qu, fileStorage, ref, { fileTransfer = null } = {}) {
  const { scheme, path: manifestId } = parseReference(ref);
  if (scheme !== "file") throw new Error(`[FileHandler] Not a file:// reference: ${ref}`);
  const qubit = await qu.get(manifestId);
  if (!qubit) throw new Error(`[FileHandler] No manifest found for ${manifestId}`);
  const manifest = qubit.value;
  const missing = await missingChunks(fileStorage, manifest);
  if (missing.length) {
    if (!fileTransfer) throw new Error(`[FileHandler] ${missing.length} chunk(s) missing locally for ${manifestId} and no fileTransfer was supplied to fetch them`);
    await fileTransfer.requestFile(manifestId);
  }
  return reassembleFile(fileStorage, manifest, qu.identity);
}
function isBytesLike2(value) {
  return value instanceof Uint8Array || typeof Blob !== "undefined" && value instanceof Blob || typeof File !== "undefined" && value instanceof File;
}
function createFileHandlerPlugin({ fileStorage } = {}) {
  if (!fileStorage) throw new Error("[FileHandler] fileStorage (a FileStorageAdapter) is required");
  const handler = {
    fileStorage,
    shareFile: (qu, id, bytes, opts) => shareFile(qu, id, bytes, { fileStorage, ...opts }),
    resolveFileRef: (qu, ref, opts) => resolveFileRef(qu, fileStorage, ref, opts),
    install(qu) {
      qu.shareFile = (id, bytes, opts) => handler.shareFile(qu, id, bytes, opts);
      qu.resolveFileRef = (ref, opts) => handler.resolveFileRef(qu, ref, opts);
      qu.fileTransfer = (channel, storage = fileStorage, opts = {}) => new DefaultFileTransfer(qu.runtime, channel, storage, { getACL: qu.acl, ...opts });
      qu.setPutHandler(async (session, id, value, opts) => {
        if (!isBytesLike2(value)) return session.publish(id, value, opts);
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
        const name = opts?.name ?? value.name;
        const mime = opts?.mime ?? value.type;
        return handler.shareFile(qu, id, bytes, { name, mime, ...opts });
      });
    }
  };
  return handler;
}

// src/modules/space-membership.js
function inboxId(fingerprint) {
  return `inbox-${fingerprint}`;
}
async function ensureSpace(qu, id, members, { readers = ["*"] } = {}) {
  const manifest = await qu.get(id);
  if (manifest) return qu.get(id);
  const allMembers = [.../* @__PURE__ */ new Set([qu.fingerprint, ...members])].sort();
  const space = qu.createSpaceAt(id, { writers: allMembers, readers, admins: allMembers });
  await space.ready.catch((e) => console.error(`[SpaceMembership] ensureSpace(): manifest write for ${id} failed:`, e));
  return space;
}
async function notifyMembers(qu, id, members, meta = {}) {
  await Promise.all(members.map((memberFp) => {
    const membersForThem = [qu.fingerprint, ...members].filter((fp) => fp !== memberFp);
    return qu.get(inboxId(memberFp)).get("requests").get(qu.fingerprint).put({
      fromFp: qu.fingerprint,
      id,
      members: membersForThem,
      ...meta
    }).catch((e) => console.error("[SpaceMembership] notifyMembers(): inbox ping failed:", memberFp, e));
  }));
}
function onSpaceInvite(qu, callback, opts) {
  return qu.get(inboxId(qu.fingerprint)).get("requests").map(callback, opts);
}
async function addSpaceMember(qu, id, members, newFp, meta = {}) {
  if (members.includes(newFp) || newFp === qu.fingerprint) return members;
  await qu.addToRole(id, "writers", newFp);
  await qu.addToRole(id, "admins", newFp);
  const updatedMembers = [...members, newFp];
  await notifyMembers(qu, id, updatedMembers, meta);
  return updatedMembers;
}
async function removeSpaceMember(qu, id, members, fp) {
  if (!members.includes(fp)) return members;
  await qu.removeFromRole(id, "writers", fp);
  await qu.removeFromRole(id, "admins", fp);
  return members.filter((m) => m !== fp);
}
function createSpaceMembershipPlugin() {
  return {
    install(qu) {
      qu.ensureSpace = (id, members, opts) => ensureSpace(qu, id, members, opts);
      qu.notifyMembers = (id, members, meta) => notifyMembers(qu, id, members, meta);
      qu.onSpaceInvite = (callback, opts) => onSpaceInvite(qu, callback, opts);
      qu.addSpaceMember = (id, members, newFp, meta) => addSpaceMember(qu, id, members, newFp, meta);
      qu.removeSpaceMember = (id, members, fp) => removeSpaceMember(qu, id, members, fp);
    }
  };
}

// src/modules/profiles.js
var ATTR_PREFIX = "attrs";
async function setProfileAttr(qu, key, value, { encryptFor: encryptFor2 } = {}) {
  return qu.own.get(ATTR_PREFIX).get(key).put(value, encryptFor2 ? { encryptFor: encryptFor2 } : void 0);
}
async function getProfileAttr(qu, fingerprint, key) {
  const q = await qu.get(`${userSpaceId(fingerprint)}/${ATTR_PREFIX}/${key}`);
  return q?.value ?? null;
}
async function deleteProfileAttr(qu, key) {
  return qu.own.get(ATTR_PREFIX).get(key).put(null);
}
async function listProfileAttrs(qu, fingerprint) {
  const prefix = `${userSpaceId(fingerprint)}/${ATTR_PREFIX}/`;
  const rows = await qu.session.query(`${userSpaceId(fingerprint)}/${ATTR_PREFIX}/**`);
  const attrs = {};
  for (const q of rows) {
    if (q.writer !== fingerprint) continue;
    if (q.value === null || q.value === void 0) continue;
    attrs[q.id.slice(prefix.length)] = q.value;
  }
  return attrs;
}
function onProfileAttrsChange(qu, fingerprint, callback, opts) {
  return qu.get(userSpaceId(fingerprint)).get(ATTR_PREFIX).map(callback, opts);
}
var DIRECTORY_ID = "qu-directory";
async function ensureDirectory(qu) {
  const manifest = await qu.get(DIRECTORY_ID);
  if (manifest) return qu.get(DIRECTORY_ID);
  const space = qu.createSpaceAt(DIRECTORY_ID, { writers: ["*"], readers: ["*"], admins: [qu.fingerprint] });
  await space.ready.catch((e) => console.error("[Profiles] ensureDirectory(): manifest write failed:", e));
  return space;
}
async function setDirectoryVisible(qu, visible) {
  await ensureDirectory(qu);
  return qu.get(DIRECTORY_ID).get("entries").get(qu.fingerprint).put({ visible: !!visible });
}
async function listDirectory(qu) {
  const rows = await qu.session.query(`${DIRECTORY_ID}/entries/**`);
  const visible = /* @__PURE__ */ new Map();
  for (const q of rows) {
    if (!q.writer) continue;
    if (q.value?.visible) visible.set(q.writer, { fingerprint: q.writer });
    else visible.delete(q.writer);
  }
  return [...visible.values()];
}
function onDirectoryChange(qu, callback, opts) {
  return qu.get(DIRECTORY_ID).get("entries").map(callback, opts);
}
function createProfilesPlugin() {
  return {
    install(qu) {
      qu.setProfileAttr = (key, value, opts) => setProfileAttr(qu, key, value, opts);
      qu.getProfileAttr = (fingerprint, key) => getProfileAttr(qu, fingerprint, key);
      qu.deleteProfileAttr = (key) => deleteProfileAttr(qu, key);
      qu.listProfileAttrs = (fingerprint) => listProfileAttrs(qu, fingerprint);
      qu.onProfileAttrsChange = (fingerprint, callback, opts) => onProfileAttrsChange(qu, fingerprint, callback, opts);
      qu.ensureDirectory = () => ensureDirectory(qu);
      qu.setDirectoryVisible = (visible) => setDirectoryVisible(qu, visible);
      qu.listDirectory = () => listDirectory(qu);
      qu.onDirectoryChange = (callback, opts) => onDirectoryChange(qu, callback, opts);
    }
  };
}

// src/modules/identity-transfer.js
var FORMAT_PREFIX = "qu-identity-v1:";
var PBKDF2_ITERATIONS = 21e4;
var ENC2 = new TextEncoder();
var DEC = new TextDecoder();
async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey("raw", ENC2.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function exportIdentity(qu, { password } = {}) {
  const keys = await qu.exportKeys();
  let envelope;
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ENC2.encode(JSON.stringify(keys))));
    envelope = { v: 1, enc: true, salt: toB64(salt), iv: toB64(iv), data: toB64(ciphertext) };
  } else {
    envelope = { v: 1, enc: false, keys };
  }
  return FORMAT_PREFIX + toB64(ENC2.encode(JSON.stringify(envelope)));
}
async function importIdentity(exported, { password } = {}) {
  const trimmed = String(exported ?? "").trim();
  if (!trimmed.startsWith(FORMAT_PREFIX)) {
    throw new Error("[identity-transfer] Unbekanntes Format \u2014 kein g\xFCltiger Qu-Identit\xE4ts-Export.");
  }
  let envelope;
  try {
    envelope = JSON.parse(DEC.decode(fromB64(trimmed.slice(FORMAT_PREFIX.length))));
  } catch {
    throw new Error("[identity-transfer] Export ist besch\xE4digt oder unvollst\xE4ndig.");
  }
  if (!envelope.enc) return envelope.keys;
  if (!password) throw new Error("[identity-transfer] Dieser Export ist passwortgesch\xFCtzt \u2014 Passwort erforderlich.");
  const key = await deriveKey(password, fromB64(envelope.salt));
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(envelope.iv) }, key, fromB64(envelope.data));
  } catch {
    throw new Error("[identity-transfer] Falsches Passwort oder besch\xE4digter Export.");
  }
  return JSON.parse(DEC.decode(plaintext));
}

// src/modules/chat.js
function randomId() {
  return crypto.randomUUID();
}
async function sendMessage(space, { text, attachments = [], encryptFor: encryptFor2, onAttachmentProgress } = {}) {
  const fp = space.session.fingerprint;
  const refs = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const fileId = `files/${fp}/${space.runtime.nextTs()}-${randomId()}`;
    const { manifestId } = await space.get(fileId).put(att.bytes, {
      name: att.name,
      mime: att.mime,
      fileStorage: att.fileStorage,
      encryptFor: encryptFor2,
      onProgress: onAttachmentProgress ? (p) => onAttachmentProgress(i, p) : void 0
    });
    refs.push(manifestId);
  }
  const result = await space.get("msgs").set({ text }, { refs: refs.length ? refs : void 0, encryptFor: encryptFor2 });
  return { ...result, refs };
}
async function listMessages(space) {
  const rows = await space.session.query(`${space.id}/msgs/**`);
  return rows.slice().sort((a, b) => a.ts - b.ts);
}
function onMessage(space, callback, opts) {
  return space.get("msgs").map(callback, opts);
}
function createChatRoom(qu, memberFingerprints, { readers = memberFingerprints } = {}) {
  return qu.createSpace({ writers: memberFingerprints, readers });
}
async function markRead(space, uptoTs) {
  return space.get(`reads/${space.session.fingerprint}`).put({ upTo: uptoTs });
}
async function getReadReceipts(space) {
  const rows = await space.session.query(`${space.id}/reads/**`);
  const receipts = {};
  for (const q of rows) {
    if (!q.writer) continue;
    const existing = receipts[q.writer];
    if (existing === void 0 || q.value.upTo > existing) receipts[q.writer] = q.value.upTo;
  }
  return receipts;
}
function onReadReceipt(space, callback, opts) {
  return space.get("reads").map(callback, opts);
}
var DEFAULT_STALE_MS = 2e4;
var DEFAULT_HEARTBEAT_MS = 8e3;
async function setPresence(space, status) {
  return space.get(`presence/${space.session.fingerprint}`).put({ status, lastSeen: space.runtime.nextTs() });
}
async function getPresence(space, { staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const rows = await space.session.query(`${space.id}/presence/**`);
  const now = Date.now();
  const presence = {};
  for (const q of rows) {
    if (!q.writer) continue;
    const isFresh = now - q.value.lastSeen < staleAfterMs;
    presence[q.writer] = { status: q.value.status, lastSeen: q.value.lastSeen, online: isFresh && q.value.status === "online" };
  }
  return presence;
}
function onPresenceChange(space, callback, opts) {
  return space.get("presence").map(callback, opts);
}
function startHeartbeat(space, { intervalMs = DEFAULT_HEARTBEAT_MS } = {}) {
  setPresence(space, "online").catch(() => {
  });
  const timer = setInterval(() => {
    setPresence(space, "online").catch(() => {
    });
  }, intervalMs);
  return async function stop() {
    clearInterval(timer);
    await setPresence(space, "offline").catch(() => {
    });
  };
}
function createChatPlugin() {
  return {
    install(qu) {
      qu.createChatRoom = (memberFingerprints, opts) => createChatRoom(qu, memberFingerprints, opts);
      qu.sendMessage = (spaceId, opts) => sendMessage(qu.get(spaceId), opts);
      qu.listMessages = (spaceId) => listMessages(qu.get(spaceId));
      qu.onMessage = (spaceId, callback, opts) => onMessage(qu.get(spaceId), callback, opts);
      qu.markRead = (spaceId, uptoTs) => markRead(qu.get(spaceId), uptoTs);
      qu.getReadReceipts = (spaceId) => getReadReceipts(qu.get(spaceId));
      qu.onReadReceipt = (spaceId, callback, opts) => onReadReceipt(qu.get(spaceId), callback, opts);
      qu.setPresence = (spaceId, status) => setPresence(qu.get(spaceId), status);
      qu.getPresence = (spaceId, opts) => getPresence(qu.get(spaceId), opts);
      qu.onPresenceChange = (spaceId, callback, opts) => onPresenceChange(qu.get(spaceId), callback, opts);
      qu.startHeartbeat = (spaceId, opts) => startHeartbeat(qu.get(spaceId), opts);
    }
  };
}

// src/ui/bindings.js
function viewKey(node, render) {
  let lastTs = null;
  return node.on((q) => {
    if (q.ts === lastTs) return;
    lastTs = q.ts;
    render(q.value, q);
  }, { initial: true });
}
function viewObject(node, { createItem, render, key = (q) => q.id, deep = false }) {
  const items = /* @__PURE__ */ new Map();
  const off = node.map((q) => {
    const k = key(q);
    let entry = items.get(k);
    if (entry && entry.ts === q.ts) return;
    if (!entry) {
      entry = { item: createItem(q), ts: null };
      items.set(k, entry);
    }
    entry.ts = q.ts;
    render(entry.item, q.value, q);
  }, { deep, initial: true });
  return () => {
    off();
    items.clear();
  };
}
var DEFAULT_ELEMENT_IO = {
  get: (el) => "value" in el ? el.value : el.textContent,
  set: (el, v) => {
    if ("value" in el) el.value = v;
    else el.textContent = v;
  },
  event: "input"
};
function bindKey(node, element, { get = DEFAULT_ELEMENT_IO.get, set = DEFAULT_ELEMENT_IO.set, event = DEFAULT_ELEMENT_IO.event, onError } = {}) {
  let lastValue;
  let lastOwnTs = null;
  const off = node.on((q) => {
    if (q.ts === lastOwnTs) return;
    lastValue = q.value;
    set(element, q.value);
  }, { initial: true });
  const onInput = async () => {
    const value = get(element);
    if (value === lastValue) return;
    const previous = lastValue;
    lastValue = value;
    const ts = node.runtime.nextTs();
    lastOwnTs = ts;
    try {
      await node.put(value, { ts });
    } catch (e) {
      lastValue = previous;
      lastOwnTs = null;
      set(element, previous ?? "");
      onError?.(e);
    }
  };
  element.addEventListener(event, onInput);
  return () => {
    off();
    element.removeEventListener(event, onInput);
  };
}
function bindObject(node, fields, opts = {}) {
  const offs = Object.entries(fields).map(([field, element]) => bindKey(node.get(field), element, opts));
  return () => offs.forEach((off) => off());
}

// src/ui/hash-router.js
function buildPath(...segments) {
  return `#/${segments.map((s) => encodeURIComponent(s)).join("/")}`;
}
function parsePathSegments(hash) {
  const raw = String(hash ?? "").replace(/^#/, "");
  if (!raw.startsWith("/")) return [];
  return raw.slice(1).split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}
export {
  DIRECTORY_ID,
  DefaultFileTransfer,
  DefaultReplication,
  IndexedDBAdapter,
  IndexedDBFileStorageAdapter,
  LocalStorageAdapter,
  MemoryAdapter,
  MemoryFileStorageAdapter,
  NullAdapter,
  PeerConnectionManager,
  QU_PRESETS,
  Qu,
  QuClock,
  QuIdentity,
  QuPipeline,
  QuRuntime,
  QuSession,
  QuSpace,
  QuStore,
  RESERVED_PROFILE_PATHS,
  ReplicationHub,
  Router,
  SessionStorageAdapter,
  addSpaceMember,
  addToRole,
  assertChannel,
  assertFileStorageAdapter,
  assertReplicationProvider,
  assertStorageAdapter,
  assertValidPattern,
  authenticateChannel,
  bindKey,
  bindObject,
  buildPath,
  compareQubits,
  createACLPlugin,
  createChatPlugin,
  createChatRoom,
  createFileHandlerPlugin,
  createIdentityACL,
  createLoopbackChannelPair,
  createNetworkPlugin,
  createProfilesPlugin,
  createRateLimiter,
  createReferenceHandlerPlugin,
  createSpace,
  createSpaceACLResolver,
  createSpaceAt,
  createSpaceMembershipPlugin,
  createSpacesPlugin,
  createVerifyPlugin,
  createWebRTCChannel,
  createWebRTCPlugin,
  createWebSocketChannel,
  debug,
  deleteProfileAttr,
  enableConsoleDebug,
  ensureDirectory,
  ensureSpace,
  exportIdentity,
  fileRef,
  filterForReader,
  fingerprintOfUserSpace,
  getPresence,
  getProfileAttr,
  getReadReceipts,
  importIdentity,
  inboxId,
  isReference,
  isReservedProfilePath,
  isUserSpaceId,
  isValidFingerprint,
  keyRef,
  listDirectory,
  listMessages,
  listProfileAttrs,
  markRead,
  missingChunks,
  notifyMembers,
  objRef,
  onDebug,
  onDirectoryChange,
  onMessage,
  onPresenceChange,
  onProfileAttrsChange,
  onReadReceipt,
  onRoutedEvent,
  onSpaceInvite,
  parsePathSegments,
  parseReference,
  publishFile,
  randomSpaceId,
  rateLimitGate,
  readFileMeta,
  reassembleFile,
  removeFromRole,
  removeSpaceMember,
  requireDirectWriterGate,
  resolveFileRef,
  resolveReference,
  resolveValue,
  sendMessage,
  sendRoutedEvent,
  setDirectoryVisible,
  setPresence,
  setProfileAttr,
  shareFile,
  spaceIdOf,
  startHeartbeat,
  userSpaceId,
  viewKey,
  viewObject
};
