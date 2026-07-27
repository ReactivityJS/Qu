import { canonical } from './sign.js';
import { encryptFor, decryptWith } from './crypto.js';
import { filterForReader } from './acl.js';
import { debug } from './debug.js';
import { subscribeWithOptions } from './subscribe-with-options.js';
import { spaceIdOf, userSpaceId, isReservedProfilePath } from './space.js';
import { QuSpace } from './space-handle.js';

const ECDH_ALG = { name: 'ECDH', namedCurve: 'P-256' };

/**
 * QuSession is the Anwendungskontext from the whitepaper: identity, crypto,
 * (optionally) a permissions view — everything the Core deliberately does
 * not know about. A Session wraps a Runtime; it never subclasses or mutates
 * it, and it registers nothing global on it. That's what makes multiple
 * Sessions over one Runtime safe: each call carries its own identity with
 * it (this Session instance), so two Sessions on the same Runtime — say,
 * two logged-in users on one server-side process, or two tabs sharing a
 * worker — cannot sign on each other's behalf, accidentally or otherwise.
 *
 * A Session may also have no identity at all (anonymous/read-only), and a
 * Runtime may have zero, one, or many Sessions over its lifetime — none of
 * that is visible to Core.
 *
 * Core never sees plaintext for encrypted values: Session encrypts before
 * calling runtime.ingest() and decrypts after runtime.get()/query() return.
 *
 * Read-ACL is opt-in here (`getACL`), not automatic: two separate
 * processes/devices each with their own Runtime never need it locally —
 * cross-boundary exposure is already gated at the Replication layer
 * (filterForReader there is mandatory, not optional). But when multiple
 * Sessions genuinely share one Runtime in one process, a Session
 * constructed with `getACL` (e.g. modules/spaces.js's resolver) also
 * filters its OWN local get()/query() results — the same check, just
 * applied at the in-process boundary instead of the network one.
 */
export class QuSession {
  #runtime;
  #identity;
  #getACL;
  #peers = new Map(); // fingerprint -> ECDH CryptoKey, for encryptFor() targets

  constructor(runtime, { identity = null, getACL = null } = {}) {
    this.#runtime = runtime;
    this.#identity = identity;
    this.#getACL = getACL;
  }

  get fingerprint() { return this.#identity?.fingerprint ?? null; }
  get identity() { return this.#identity; }
  get runtime() { return this.#runtime; }

  /** Learn another identity's ECDH public key out-of-band, so this Session can encrypt data *for* them. (Signature verification never needs this — fingerprint = hash(pubKey) is enough.) Takes precedence over a published `~<fp>/epub` if both are known. */
  async trustPeer(fingerprint, encPubJwk) {
    this.#peers.set(fingerprint, await crypto.subtle.importKey('jwk', encPubJwk, ECDH_ALG, true, []));
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
    if (!readers || readers.includes('*')) return null;
    return [...new Set([...readers, this.fingerprint])];
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
          key = await crypto.subtle.importKey('jwk', q.value, ECDH_ALG, true, []);
          this.#peers.set(fingerprint, key);
        } catch (e) {
          debug('session', 'epub-import-failed', { fingerprint, error: e.message });
        }
      }
    }
    if (!key) throw new Error(`[Session] Unknown ECDH public key for recipient "${fingerprint}" — call trustPeer() first, or have them publish it (Qu#publishProfile()).`);
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
    id = String(id); // tolerate anything with a sensible toString() (e.g. QuSpace), not just plain strings
    // A QuSpace as the ID (above) is fine — String(node) is exactly its SpaceId.
    // A QuSpace as the VALUE is almost certainly a mistake: it looks like it
    // works locally (the raw instance sits in a MemoryAdapter's Map, and
    // signing already narrows it via JSON.stringify -> its toJSON() -> the
    // bare id), but the STORED value is not that string, it's the live
    // instance — the moment this qubit crosses any real serialization
    // boundary (network send, disk persistence via a real StorageAdapter),
    // it collapses to the bare id with no `key://` prefix, silently
    // unrecognizable as a reference by isReference()/resolveReference().
    // Fail loudly here instead of shipping that footgun.
    if (plainValue instanceof QuSpace) {
      throw new Error(`[Session] publish()/put()/set() erhielt eine QuSpace-Instanz als WERT, nicht als Id — das ist fast immer ein Versehen. Für eine explizite Referenz auf einen anderen Space: node.put(keyRef(otherSpace.id)) (data/references.js), nicht node.put(otherSpace).`);
    }
    let value = plainValue;
    if (recipients === undefined) recipients = await this.#defaultRecipients(id);
    if (recipients && recipients.length) {
      if (!this.#identity) throw new Error('[Session] Cannot encrypt without an identity');
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
    if (!this.#identity) throw new Error('[Session] append() requires an identity — anonymous writes cannot be namespaced');
    const ts = opts.ts ?? this.#runtime.nextTs();
    const id = `${collectionId}/${this.#identity.fingerprint}-${ts}`;
    return this.publish(id, plainValue, { ...opts, ts });
  }

  /**
   * `encrypted: true` is now set on EVERY path through here, including a
   * successful decrypt (previously only on the two failure paths below) —
   * an addressed recipient could decrypt a value just fine but had no way
   * to tell afterward that it HAD been encrypted at all (a plain qubit
   * never reaches this branch, see the early return above, so the two are
   * otherwise indistinguishable). Nothing in this codebase branched on
   * `.encrypted`'s previous absence-on-success (grep finds no reader
   * outside this file before this change), so widening it is safe —
   * modules/profiles.js's setProfileAttr()/listProfileAttrs() are the
   * first consumer, to let an owner see which of their OWN custom
   * attributes are currently private (encrypted for themselves only) vs.
   * public (plain).
   */
  async #decrypt(qubit) {
    if (!qubit || !qubit.value || qubit.value.__qu_enc !== 1) return qubit;
    if (!this.#identity) return { ...qubit, value: undefined, encrypted: true };
    // A malformed/corrupted envelope (missing `keys`, truncated `iv`/
    // `ciphertext`, ...) makes decryptWith() throw instead of resolving —
    // any writer with ACCESS to this id can produce this once (accidentally
    // or not). Left uncaught, that one bad qubit would reject query()'s
    // Promise.all() for EVERY row in the batch, and on()'s per-event
    // decrypt would surface as an unhandled-rejection-shaped error instead
    // of the same "can't read this one" outcome a wrong-recipient qubit
    // already produces below. Treat it the same way: undecryptable, not
    // fatal to the caller.
    let plain;
    try {
      plain = await decryptWith(this.#identity, qubit.value);
    } catch (e) {
      debug('session', 'decrypt-error', { id: qubit.id, error: e.message });
      return { ...qubit, value: undefined, encrypted: true };
    }
    if (plain === undefined) return { ...qubit, value: undefined, encrypted: true }; // not an addressed recipient
    return { ...qubit, value: plain, encrypted: true };
  }

  async get(id) {
    const q = await this.#runtime.get(String(id)); // tolerate anything with a sensible toString() (e.g. QuSpace)
    if (q && this.#getACL) {
      const [visible] = await filterForReader([q], this.fingerprint, this.#getACL);
      if (!visible) return null;
    }
    return this.#decrypt(q);
  }

  async query(pattern) {
    let rows = await this.#runtime.query(String(pattern)); // tolerate anything with a sensible toString() (e.g. QuSpace)
    if (this.#getACL) rows = await filterForReader(rows, this.fingerprint, this.#getACL);
    return Promise.all(rows.map((q) => this.#decrypt(q)));
  }

  /** See Runtime.on() for `initial`/`once` semantics — this is the same thing, but every delivered qubit (initial batch and live) goes through decrypt() first, matching query()'s existing behaviour. */
  on(pattern, callback, opts) {
    pattern = String(pattern); // tolerate anything with a sensible toString() (e.g. QuSpace)
    const decryptedSubscribe = (p, cb) => this.#runtime.on(p, (q) => {
      // Deliberately NOT `return this.#decrypt(q).then(cb)` — a bare
      // block-body arrow here previously discarded that promise entirely,
      // so if `cb` threw or its own returned promise rejected (e.g. an
      // async render function failing on one particular message), it
      // became a silent unhandled rejection invisible to the caller, to
      // QuSubscriptionEngine's own listener-error handling (which never
      // even saw a promise to attach to), and to safeInvoke() at the
      // Channel layer (this path doesn't go through a Channel at all).
      this.#decrypt(q).then(cb).catch((e) => {
        debug('session', 'on-callback-error', { id: q.id, error: e.message });
        console.error(`[Session] on() callback failed for ${q.id}:`, e);
      });
    });

    if (!opts) return decryptedSubscribe(pattern, callback);
    return subscribeWithOptions({
      queryFn: (p) => this.query(p), // already decrypted + ACL-filtered
      subscribeFn: decryptedSubscribe,
      pattern, callback, ...opts,
    });
  }

  /** Resolves a QuBit's refs to the QuBits they point at (decrypted if this Session can). Manual, not automatic/reactive — Core stays a dumb store, apps decide when to follow a link. */
  async resolveRefs(qubit) {
    if (!qubit?.refs?.length) return [];
    return Promise.all(qubit.refs.map((id) => this.get(id)));
  }
}
