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
//   node.put(value, opts)     write AT this node (LWW-Register). `value`
//                             instanceof Uint8Array (or Blob/File in a
//                             browser) is auto-detected as a file IF a
//                             FileHandler is configured (see putDispatch
//                             below) — chunked+manifested instead of
//                             written raw. No FileHandler configured and
//                             bytes given -> throws, rather than silently
//                             writing raw bytes as an opaque "value".
//   node.set(value, opts)     collision-safe write into a shared
//                             collection at this node (many independent
//                             writers, e.g. chat messages) — see
//                             QuSession.append().
//   node.on(callback, opts)   live subscription to THIS node's own value
//                             (`{ initial, once }`, same semantics as
//                             QuSession.on()).
//   node.map(callback, opts)  live subscription to this node's CHILDREN —
//                             `${id}/*` (opts.deep: true -> `${id}/**`,
//                             for collections written via set(), which
//                             namespace two segments deep). Same
//                             `{ initial, once }`.
//
// A node is also THENABLE — `await node` (or `.then()`) reads the node's
// OWN current value, delegating to Session.get(node.id). Navigating
// (get()) and reading (await) are deliberately orthogonal: `qu.get(id)`
// never does I/O by itself; `await qu.get(id)` does exactly the I/O the
// old `qu.get(id)` used to.
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

  /**
   * `putDispatch(session, id, value, opts)`, if given, replaces the default
   * `session.publish(id, value, opts)` for put() — this is the hook
   * createFileHandlerPlugin()/qu.setPutHandler() installs so put()'s
   * Uint8Array auto-detection works without QuSpace (Core) needing to know
   * Files/plugins exist at all. Defaults to plain publish() so QuSpace
   * stays usable standalone (e.g. modules/spaces.js's createSpace()).
   */
  constructor(session, spaceId, { guest = false, putDispatch } = {}) {
    this.#session = session;
    this.#id = String(spaceId);
    this.#guest = guest;
    this.#putDispatch = putDispatch ?? ((s, id, value, opts) => s.publish(id, value, opts));
  }

  get id() { return this.#id; }
  toString() { return this.#id; }
  toJSON() { return this.#id; }

  /** Escape hatch, same as qu.runtime — lets a QuSpace be passed anywhere a Qu instance was expected (e.g. ui/bindings.js's bindKey(), which needs runtime.nextTs() for its echo guard). */
  get runtime() { return this.#session.runtime; }

  /** Escape hatch, same as qu.session — for callers that need a one-shot array of matches (session.query()) rather than the live/single-value shape get()/on()/map() give, e.g. data/references.js's obj:// resolution. */
  get session() { return this.#session; }

  /** Reading this node's own current value — `await node` and `node.then()` are the same thing. */
  then(onFulfilled, onRejected) {
    return this.#session.get(this.#id).then(onFulfilled, onRejected);
  }

  #assertCanWrite(action) {
    if (this.#guest) throw new Error(`[QuSpace] Guest-Sessions haben kein Schreibrecht (versucht: ${action} auf ${this.#id}). Mit Qu.create({ identity }) eine echte Identität verwenden.`);
  }

  /** Navigate to a child node — synchronous, no I/O, just builds `${id}/${subpath}`. */
  get(subpath) {
    if (!subpath) return this;
    return new QuSpace(this.#session, `${this.#id}/${subpath}`, { guest: this.#guest, putDispatch: this.#putDispatch });
  }

  /** Write AT this node (LWW). Bytes route through putDispatch — plain publish() unless a FileHandler is configured. */
  async put(value, opts) {
    this.#assertCanWrite('put');
    return this.#putDispatch(this.#session, this.#id, value, opts);
  }

  /** Collision-safe write into a shared collection at this node — see QuSession.append(). */
  async set(value, opts) {
    this.#assertCanWrite('set');
    return this.#session.append(this.#id, value, opts);
  }

  /** Live subscription to this node's own value. */
  on(callback, opts) { return this.#session.on(this.#id, callback, opts); }

  /**
   * Live subscription to this node's children — `${id}/*`, or `${id}/**`
   * with `{ deep: true }` (for set()-based collections, which namespace two
   * segments deep). Defaults to `initial: true` (deliver what already
   * exists, then keep delivering live) — unlike on(), which defaults to
   * forward-only, map()'s whole point is "give me everything here, kept
   * live", matching what every current caller (viewObject(), <qu-list>)
   * already wants; pass `{ initial: false }` for forward-only.
   */
  map(callback, { deep = false, initial = true, ...opts } = {}) {
    const pattern = deep ? `${this.#id}/**` : `${this.#id}/*`;
    return this.#session.on(pattern, callback, { initial, ...opts });
  }
}
