// QuSpace: a thin, stateless view scoped to one Space's prefix — the same
// publish/append/get/query/on surface as Qu itself, but every path argument
// is relative to this Space's own id instead of needing to be spelled out
// in full each time. Not a new identity/session — it wraps the SAME
// underlying Session a Qu instance already has, so writes are signed/
// ACL-checked exactly as if you'd called qu.publish() with the full path
// yourself; a QuSpace changes nothing about WHAT gets checked, only how
// much of the path you have to type.
//
// Three ways to get one (see qu.js):
//   qu.own                 — bound to your own User-Space (~<fingerprint>).
//                            Deliberately NOT the same thing as making
//                            qu.publish(id, ...) itself reinterpret
//                            non-absolute ids as relative — several
//                            existing tests/docs demonstrate the strict
//                            Core default ACL precisely by writing to an
//                            arbitrary NON-absolute path and expecting it
//                            to be denied (see core/identity-acl.js); qu.own
//                            is the same ergonomic win as an explicit,
//                            unambiguous opt-in instead.
//   qu.space(spaceId)       — bound to any known Space: yours, someone
//                            else's User-Space ("~<their-fp>"), or a
//                            generic Space (its UUID). Reading is gated
//                            only by that Space's `readers`, writing only
//                            by its `writers`/`admins` — exactly like
//                            calling qu.publish()/qu.get() with the full id
//                            would be. Building the handle itself needs no
//                            plugin and does no ACL/manifest lookup — only
//                            the actual publish/get/query/on calls do,
//                            lazily, same as always.
//   qu.createSpace(opts)    — creates a brand-new generic Space (requires
//                            the Spaces plugin) and returns a QuSpace for
//                            it directly, so the manifest write and the
//                            first real write can both go through the
//                            handle without re-deriving the id.
//
// toString()/toJSON() return the plain SpaceId string, and every id/pattern
// argument QuSession accepts is coerced with String() at the door — so
// existing code that does `${room}/msg`, JSON.stringify({ room }), or even
// passes a QuSpace directly as an id (`qu.get(room)`) keeps working exactly
// as if `room` were the plain string all along.
export class QuSpace {
  #session;
  #id;
  #guest;

  constructor(session, spaceId, { guest = false } = {}) {
    this.#session = session;
    this.#id = String(spaceId);
    this.#guest = guest;
  }

  get id() { return this.#id; }
  toString() { return this.#id; }
  toJSON() { return this.#id; }

  /** Escape hatch, same as qu.runtime — lets a QuSpace be passed anywhere a Qu instance was expected (e.g. src/ui/bindings.js's bindKey(), which needs runtime.nextTs() for its echo guard), not just to publish/get/query/on. */
  get runtime() { return this.#session.runtime; }

  /** Falsy subpath (omitted or '') means the Space's own root id — the manifest, or wherever a root-level value would live. */
  #resolve(subpath) {
    return subpath ? `${this.#id}/${subpath}` : this.#id;
  }

  #assertCanWrite(action) {
    if (this.#guest) throw new Error(`[QuSpace] Guest-Sessions haben kein Schreibrecht (versucht: ${action} auf ${this.#id}). Mit Qu.create({ identity }) eine echte Identität verwenden.`);
  }

  async publish(subpath, value, opts) {
    this.#assertCanWrite('publish');
    return this.#session.publish(this.#resolve(subpath), value, opts);
  }

  /** Collision-safe write for shared collections within this Space — see QuSession.append(). */
  async append(subpath, value, opts) {
    this.#assertCanWrite('append');
    return this.#session.append(this.#resolve(subpath), value, opts);
  }

  async get(subpath) { return this.#session.get(this.#resolve(subpath)); }
  async query(pattern) { return this.#session.query(this.#resolve(pattern)); }
  on(pattern, callback, opts) { return this.#session.on(this.#resolve(pattern), callback, opts); }
}
