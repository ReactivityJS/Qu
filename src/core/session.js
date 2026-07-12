import { canonical } from './sign.js';
import { encryptFor, decryptWith } from './crypto.js';
import { filterForReader } from './acl.js';
import { debug } from './debug.js';
import { subscribeWithOptions } from './subscribe-with-options.js';

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

  /** Learn another identity's ECDH public key out-of-band, so this Session can encrypt data *for* them. (Signature verification never needs this — fingerprint = hash(pubKey) is enough.) */
  async trustPeer(fingerprint, encPubJwk) {
    this.#peers.set(fingerprint, await crypto.subtle.importKey('jwk', encPubJwk, ECDH_ALG, true, []));
  }

  async publish(id, plainValue, { ts, encryptFor: recipients, refs } = {}) {
    id = String(id); // tolerate anything with a sensible toString() (e.g. QuSpace), not just plain strings
    let value = plainValue;
    if (recipients && recipients.length) {
      if (!this.#identity) throw new Error('[Session] Cannot encrypt without an identity');
      const targets = recipients.map((fp) => {
        const key = fp === this.fingerprint ? this.#identity.encryptionKey : this.#peers.get(fp);
        if (!key) throw new Error(`[Session] Unknown ECDH public key for recipient "${fp}" — call trustPeer() first`);
        return { fingerprint: fp, ecdhPublicKey: key };
      });
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
   * fingerprint before publishing, `${collectionId}/${fingerprint}/${ts}`.
   * Two different writers can now never collide (different fingerprint =
   * different path, structurally, not by convention someone has to
   * remember), and no ACL special-casing is needed — `spaceIdOf(id)` is
   * still the same collection's Space either way, so write-ACL/read-ACL
   * are checked exactly like any other publish(). This is the standard
   * LWW-Register vs. (writer-partitioned) grow-only-Set split from CRDT
   * theory, not a one-off convention invented for chat.
   */
  async append(collectionId, plainValue, opts = {}) {
    if (!this.#identity) throw new Error('[Session] append() requires an identity — anonymous writes cannot be namespaced');
    const ts = opts.ts ?? this.#runtime.nextTs();
    const id = `${collectionId}/${this.#identity.fingerprint}/${ts}`;
    return this.publish(id, plainValue, { ...opts, ts });
  }

  async #decrypt(qubit) {
    if (!qubit || !qubit.value || qubit.value.__qu_enc !== 1) return qubit;
    if (!this.#identity) return { ...qubit, value: undefined, encrypted: true };
    const plain = await decryptWith(this.#identity, qubit.value);
    if (plain === undefined) return { ...qubit, value: undefined, encrypted: true }; // not an addressed recipient
    return { ...qubit, value: plain };
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
