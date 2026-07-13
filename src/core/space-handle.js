// QuSpace: a thin, stateless node bound to one Space/path — GunDB-inspired
// (`gun.get(key).put(x)`/`.on(cb)`/`.map(cb)`), adapted to QU's signed,
// ACL-checked write model. Not a new identity/session — it wraps the SAME
// underlying Session a Qu instance already has, so writes are signed/
// ACL-checked exactly as if you'd called the equivalent Session method with
// the full path yourself; a QuSpace changes nothing about WHAT gets
// checked, only how the path gets built and how you interact with it.
//
// Five verbs, one object type:
//   node.get(subpath)        navigate — returns ANOTHER node bound to
//                             `${node.id}/${subpath}`. Synchronous, no I/O.
//   node.put(value, opts)     write AT this node (LWW-Register) — a NAMED,
//                             SINGLE value. Node itself holds it; `await
//                             node` reads it back; a second put() on the
//                             same node overwrites, doesn't accumulate.
//                             `value` instanceof Uint8Array (or Blob/File
//                             in a browser) is auto-detected as a file IF a
//                             FileHandler is configured (see putDispatch
//                             below) — chunked+manifested instead of
//                             written raw. No FileHandler configured and
//                             bytes given -> throws, rather than silently
//                             writing raw bytes as an opaque "value".
//   node.set(value, opts)     collision-safe write into a shared, ARRAY-
//                             LIKE collection AT this node (many
//                             independent writers, e.g. chat messages) —
//                             node itself is NEVER written to; each set()
//                             creates a distinct new CHILD instead (one
//                             path segment deep, namespaced by writer
//                             fingerprint — see QuSession.append()). `await
//                             node` after only set() calls returns null —
//                             there's nothing AT node itself. Read the
//                             growing list via node.map()/session.query(),
//                             not `await node`.
//   node.on(callback, opts)   live subscription to THIS node's own value
//                             (`{ initial, once }`, same semantics as
//                             QuSession.on()).
//   node.map(callback, opts)  live subscription to this node's CHILDREN —
//                             `${id}/*`, which already finds set()-created
//                             entries too (one segment deep either way).
//                             `opts.deep: true` -> `${id}/**` for a
//                             genuinely deeper hierarchy an app built
//                             itself (e.g. leaf-per-field items). Same
//                             `{ initial, once }`.
//
// A node is also THENABLE — `await node` (or `.then()`) reads the node's
// OWN current value, delegating to Session.get(node.id). Navigating
// (get()) and reading (await) are deliberately orthogonal: `qu.get(id)`
// never does I/O by itself; `await qu.get(id)` does exactly the I/O the
// old `qu.get(id)` used to.
//
// References (`key://<id>`, see data/references.js) are followed
// TRANSPARENTLY by default in put/set/on/map/await — `resolveDispatch`
// (installed by createReferenceHandlerPlugin() via qu.setResolveHandler(),
// defaults to the identity function so Core itself stays unaware `key://`
// means anything) resolves the node's OWN id through any chained `key://`
// redirects exactly once per call, THEN the verb proceeds exactly as if
// you'd built that resolved id yourself. Pass `{ raw: true }` to skip
// this and use the literal id, unresolved — for `await node` specifically
// (which takes no options, being the thenable protocol) the equivalent
// escape hatch is `await node.session.get(node.id)`. See the module doc
// in data/references.js and API.md's References-Modul section for the
// full explanation, cost model, and pitfalls (only `key://` auto-follows;
// `obj://`/`file://` stay explicit; `.get()` navigation itself is
// UNCHANGED — always sync, never resolves anything).
//
// Three ways to get a node (see qu.js):
//   qu.own                 — bound to your own User-Space (~<fingerprint>).
//   qu.get(spaceId)         — bound to any known Space: yours, someone
//                            else's User-Space ("~<their-fp>"), or a
//                            generic Space (its UUID). Reading is gated
//                            only by that Space's `readers`, writing only
//                            by its `writers`/`admins`. Building the node
//                            itself needs no plugin and does no
//                            ACL/manifest lookup — only put/set/on/map do,
//                            lazily, same as always.
//   qu.createSpace(opts)    — creates a brand-new generic Space (requires
//                            the Spaces plugin) and returns a node for it
//                            directly.
//
// toString()/toJSON() return the plain SpaceId string, and every id/pattern
// argument QuSession accepts is coerced with String() at the door — so a
// node is a safe drop-in wherever a raw SpaceId string was expected:
// `${room}/msg`, `JSON.stringify({ room })`, or passing it directly as an
// id argument (`qu.session.get(room)`).
export class QuSpace {
  #session;
  #id;
  #guest;
  #putDispatch;
  #resolveDispatch;

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
   */
  constructor(session, spaceId, { guest = false, putDispatch, resolveDispatch } = {}) {
    this.#session = session;
    this.#id = String(spaceId);
    this.#guest = guest;
    this.#putDispatch = putDispatch ?? ((s, id, value, opts) => s.publish(id, value, opts));
    this.#resolveDispatch = resolveDispatch ?? (async (s, id) => id);
  }

  get id() { return this.#id; }
  toString() { return this.#id; }
  toJSON() { return this.#id; }

  /** Escape hatch, same as qu.runtime — lets a QuSpace be passed anywhere a Qu instance was expected (e.g. ui/bindings.js's bindKey(), which needs runtime.nextTs() for its echo guard). */
  get runtime() { return this.#session.runtime; }

  /**
   * Escape hatch, same as qu.session — for callers that need a one-shot
   * array of matches (session.query()) rather than the live/single-value
   * shape get()/on()/map() give, e.g. data/references.js's obj://
   * resolution. Also the way to read a node's value WITHOUT reference
   * resolution (`await node` always resolves — there's no options
   * parameter on the thenable protocol to pass `{ raw: true }` to):
   * `await node.session.get(node.id)`.
   */
  get session() { return this.#session; }

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
    return this.#resolveDispatch(this.#session, this.#id)
      .then((targetId) => this.#session.get(targetId))
      .then(onFulfilled, onRejected);
  }

  #assertCanWrite(action) {
    if (this.#guest) throw new Error(`[QuSpace] Guest-Sessions haben kein Schreibrecht (versucht: ${action} auf ${this.#id}). Mit Qu.create({ identity }) eine echte Identität verwenden.`);
  }

  /** Navigate to a child node — synchronous, no I/O, just builds `${id}/${subpath}`. */
  get(subpath) {
    if (!subpath) return this;
    return new QuSpace(this.#session, `${this.#id}/${subpath}`, { guest: this.#guest, putDispatch: this.#putDispatch, resolveDispatch: this.#resolveDispatch });
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
    this.#assertCanWrite('put');
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
    this.#assertCanWrite('set');
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
   * subscribe-with-options.js's `initial`/`once` catch-up). Pass
   * `{ raw: true }` for the old, purely synchronous, zero-setup-gap
   * behavior against the literal id (no resolution at all).
   */
  on(callback, opts) {
    if (opts?.raw) return this.#session.on(this.#id, callback, opts);
    let unsubscribeInner = null;
    let cancelled = false;
    this.#resolveDispatch(this.#session, this.#id)
      .then((targetId) => {
        if (cancelled) return;
        unsubscribeInner = this.#session.on(targetId, callback, opts);
      })
      .catch((e) => { if (!cancelled) console.error(`[QuSpace] on(): Auflösen von "${this.#id}" fehlgeschlagen:`, e); });
    return () => { cancelled = true; if (unsubscribeInner) unsubscribeInner(); };
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
   * re-resolving per event. Pass `{ raw: true }` to skip resolution.
   */
  map(callback, { deep = false, initial = true, raw = false, ...opts } = {}) {
    if (raw) {
      const pattern = deep ? `${this.#id}/**` : `${this.#id}/*`;
      return this.#session.on(pattern, callback, { initial, ...opts });
    }
    let unsubscribeInner = null;
    let cancelled = false;
    this.#resolveDispatch(this.#session, this.#id)
      .then((targetId) => {
        if (cancelled) return;
        const pattern = deep ? `${targetId}/**` : `${targetId}/*`;
        unsubscribeInner = this.#session.on(pattern, callback, { initial, ...opts });
      })
      .catch((e) => { if (!cancelled) console.error(`[QuSpace] map(): Auflösen von "${this.#id}" fehlgeschlagen:`, e); });
    return () => { cancelled = true; if (unsubscribeInner) unsubscribeInner(); };
  }
}
