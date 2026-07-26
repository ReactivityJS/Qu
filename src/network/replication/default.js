import { assertChannel } from '../../core/channel.js';
import { filterForReader } from '../../core/acl.js';
import { debug } from '../../core/debug.js';
import { QuPipeline } from '../../core/pipeline.js';
import { requireDirectWriterGate, rateLimitGate } from '../ingest-gate.js';

/**
 * DefaultReplication: intentionally the simplest thing that works.
 *
 *   1. Delta-sync by topic + timestamp (`since`).
 *   2. Incoming qubits are ingested through Runtime.ingest(), which runs the
 *      full verify/ACL commit pipeline and is idempotent by (id, ts) — so
 *      re-receiving something already known is a safe no-op ("dedup by ID"
 *      isn't separate logic, it's a Store property: see store.js).
 *   3. repair() re-requests a small overlapping window instead of trusting
 *      `since` exactly — absorbs clock skew and brief gaps for free,
 *      because step 2 makes re-delivery harmless.
 *   4. Every response/push is checked against isReplicable() (declarative
 *      local-only mounts, hard boundary) AND filterForReader() (per-QuBit
 *      read ACL) before anything leaves this process. Neither check is
 *      optional or left to the caller to remember.
 *
 * Offline clients and the "queue" question: there is no separate outbox
 * data structure. The Store itself is the durable queue — everything
 * written offline is already sitting there, addressable by (topic, ts).
 * What was missing was making sync() *reciprocal*: when peer A asks this
 * side for "what's new in topic T since X", this side — once it has
 * answered — automatically asks A the same question back (once, not
 * recursively; the reciprocated request is marked so it isn't reciprocated
 * again). A single sync() call from either side on reconnect therefore
 * flushes both directions, including whatever the peer wrote while
 * offline, without any extra bookkeeping about "pending" writes.
 *
 * Live delivery: newly ingested QuBits (local or from elsewhere) are also
 * pushed to connected, authorized peers immediately via runtime.on('**'),
 * instead of only being discoverable on the next sync(). A small bounded
 * "recently received from this peer" cache prevents pointlessly echoing a
 * QuBit straight back to the peer it just arrived from — this is a
 * traffic optimization, not a correctness requirement, since Store
 * idempotency already makes an echo harmless.
 *
 * 5. Before any of that: every incoming `qu.push` runs through an "ingest
 *    gate" — a QuPipeline (core/pipeline.js, the SAME middleware primitive
 *    Runtime.ingest() itself uses for Verify/ACL) built from
 *    `requireDirectWriter`/`rateLimiter` (shorthand for the two built-in
 *    gates in network/ingest-gate.js) plus whatever custom
 *    `(ctx, next) => Promise<void>` middleware the `ingestGate` option
 *    supplies. A gate throws to reject (silently dropped, logged via
 *    debug()) — a THIRD incoming-push protection is a new middleware
 *    function passed in, not a new constructor flag and a new if-check
 *    hard-coded into #handleMessage().
 */
export class DefaultReplication {
  #runtime;
  #channel;
  #channelId;
  #getACL;
  #peerFingerprint;
  #repairWindowMs;
  #lastSync = new Map(); // topic -> last known-good `since` cursor
  #pending = new Map();
  #reqId = 0;
  #off;
  #offPush;
  #recentlyFromPeer = new Map(); // `${id}|${ts}` -> true, bounded LRU-ish de-echo cache
  #pushTopics;
  #router;
  #ingestGate;
  #allowDynamicSubscribe;
  #maxDynamicTopics;
  #dynamicTopicsAdded = 0;

  constructor(runtime, channel, {
    getACL = async () => null,
    peerFingerprint = null,
    repairWindowMs = 5 * 60 * 1000,
    pushTopics = [],
    router = null, // optional — see core/router.js. Unset: identical behaviour to before the Router existed.
    // All three opt-in, all about INCOMING `qu.push` only — see
    // #handleMessage and network/ingest-gate.js. None change outgoing
    // behavior (still governed by ACL/pushTopics/Router as before), and
    // none are on unless the caller asks for them — existing callers
    // (Qu.connect(), a bare `new DefaultReplication()`) keep today's
    // behavior unchanged. requireDirectWriter/rateLimiter are shorthand for
    // the two built-in gates (network/ingest-gate.js's
    // requireDirectWriterGate()/rateLimitGate()) — reach for `ingestGate`
    // directly for a custom policy instead of a fourth constructor flag.
    requireDirectWriter = false, // true: only accept a push whose qubit.writer is THIS channel's own proven peerFingerprint — rejects relayed/forwarded qubits, enforcing a star topology where the Relay only ever hears a write from its actual author. A qubit's signature already makes forgery impossible either way; this is about WHO may hand a given write to this particular connection, not about authenticity.
    rateLimiter = null, // a createRateLimiter() instance (network/rate-limiter.js), or any `{ allow(key) => boolean }`. Keyed by the incoming qubit's writer (falls back to peerFingerprint, then the channel id, for the rare anonymous/unsigned case) — one peer flooding writes never starves another peer's budget.
    ingestGate = [], // additional `(ctx, next) => Promise<void>` middleware, ctx = { qubit, peerFingerprint, channelId } — run after requireDirectWriter/rateLimiter, in array order. Throw to reject (same convention as core/acl.js), call next() to allow.
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
    maxDynamicTopics = 200,
  } = {}) {
    this.#runtime = runtime;
    this.#channel = assertChannel(channel);
    this.#channelId = channel.id;
    this.#getACL = getACL;
    this.#peerFingerprint = peerFingerprint;
    this.#repairWindowMs = repairWindowMs;
    this.#pushTopics = [...pushTopics]; // own copy — #handleSubscribeRequest() mutates this, must never alias the caller's array
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
    if (!this.#offPush) this.#offPush = this.#runtime.on('**', (q) => this.#maybePush(q));
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
    if (this.#pushTopics.includes(topic)) return; // already active — no-op, doesn't count against the cap
    if (this.#allowDynamicSubscribe === false) {
      debug('replication', 'subscribe-rejected-disabled', { topic, channelId: this.#channelId });
      return;
    }
    if (Array.isArray(this.#allowDynamicSubscribe) && !this.#allowDynamicSubscribe.some((c) => topic.startsWith(c))) {
      debug('replication', 'subscribe-rejected-outside-ceiling', { topic, channelId: this.#channelId });
      return;
    }
    if (this.#dynamicTopicsAdded >= this.#maxDynamicTopics) {
      debug('replication', 'subscribe-rejected-cap', { topic, channelId: this.#channelId, cap: this.#maxDynamicTopics });
      return;
    }
    this.#pushTopics.push(topic);
    this.#dynamicTopicsAdded++;
    this.#ensurePushListening();
    debug('replication', 'subscribe-accepted', { topic, channelId: this.#channelId });
  }

  async #maybePush(q) {
    if (q.ephemeral) return;
    if (this.#recentlyFromPeer.has(`${q.id}|${q.ts}`)) return;
    if (!this.#pushTopics.some((t) => q.id.startsWith(t))) return;
    // A Router, if present, gets the final say on whether THIS channel is
    // one of the chosen paths for this specific qubit (mirror routes are
    // always chosen; sync routes only when this channel wins its group,
    // or was never grouped at all — see core/router.js). No router
    // registered for this channel at all (e.g. it was never addRoute()'d)
    // is treated as "not gated by routing" — same as having no router,
    // so existing call sites that don't use the Router keep working
    // unchanged.
    if (this.#router && this.#router.getRoute(this.#channelId) && !this.#router.isChosen(this.#channelId, q)) {
      debug('replication', 'push-skipped-by-router', { id: q.id, channelId: this.#channelId });
      return;
    }
    try {
      if (!(await this.#isVisible(q))) return;
      await this.#channel.send({ type: 'qu.push', qubit: q });
      debug('replication', 'push-sent', { id: q.id });
    } catch (e) {
      debug('replication', 'push-failed', { id: q.id, error: e.message });
      console.error(`[Replication] failed to push ${q.id}:`, e.message);
    }
  }

  async #handleMessage(msg) {
    if (msg.type === 'qu.subscribe') {
      this.#handleSubscribeRequest(msg.topic);
      return;
    }

    if (msg.type === 'qu.push') {
      // A push with no `qubit` at all (malformed/malicious peer) would
      // otherwise reach #rememberFromPeer()/the ingest gate below and throw
      // on `q.id`/`q.ts` — outside the try/catch blocks that exist
      // specifically so a bad push can't crash the connection.
      if (!msg.qubit || typeof msg.qubit !== 'object') {
        debug('replication', 'push-malformed', { channelId: this.#channelId });
        return;
      }
      try {
        const ctx = { qubit: msg.qubit, peerFingerprint: this.#peerFingerprint, channelId: this.#channelId };
        await this.#ingestGate.run(ctx, async () => {});
      } catch (e) {
        debug('replication', 'push-rejected-by-gate', { id: msg.qubit?.id, writer: msg.qubit?.writer, error: e.message });
        return;
      }
      this.#rememberFromPeer(msg.qubit);
      try {
        await this.#runtime.ingest(msg.qubit);
        debug('replication', 'push-ingested', { id: msg.qubit.id });
      } catch (e) {
        // A pushed qubit can legitimately fail ingest (ACL denial, a stale
        // signature, a malformed payload from a misbehaving peer) — that
        // must never crash the connection or the process. Previously this
        // await was unguarded, so any rejection here became an unhandled
        // promise rejection (Node's default: terminate the process).
        debug('replication', 'push-rejected', { id: msg.qubit?.id, error: e.message });
        console.error(`[Replication] rejected incoming push for ${msg.qubit?.id}:`, e.message);
      }
      return;
    }

    if (msg.type === 'qu.sync.request') {
      // `${topic}/**` structurally excludes the topic's OWN id (the regex
      // requires a literal '/' after it — see runtime.js's patternToRegExp)
      // — for a Space, that id is exactly its manifest. Without this, a
      // late-joining client could sync() a room's content but could never
      // learn who's allowed to read/write it unless it happened to be
      // connected at the exact moment the manifest was written (live
      // push only) — a real gap for the common "join a Space via a link"
      // flow, not a hypothetical one. Harmless when `topic` isn't itself a
      // document id (e.g. a bare prefix like `'~fp/msgs/'`): get() then
      // simply returns null and contributes nothing.
      // `msg.topic` is peer-controlled and reaches assertValidPattern()
      // (via runtime.query()) unvalidated — a topic already containing a
      // non-terminal `**` (e.g. "a/**/b") makes the appended `/**` pattern
      // invalid, throwing synchronously instead of just yielding an empty
      // result the way an ordinary unknown/empty topic already does.
      let ownDoc, rows;
      try {
        ownDoc = await this.#runtime.get(msg.topic);
        rows = await this.#runtime.query(`${msg.topic}/**`);
      } catch (e) {
        debug('replication', 'sync-request-malformed', { topic: msg.topic, error: e.message });
        return;
      }
      const all = ownDoc ? [ownDoc, ...rows] : rows;
      const inRange = all.filter((q) => q.ts >= msg.since);
      const replicable = inRange.filter((q) => this.#runtime.store.isReplicable(q.id));
      const visible = await filterForReader(replicable, this.#peerFingerprint, this.#getACL);
      debug('replication', 'sync-response', { topic: msg.topic, count: visible.length });
      await this.#channel.send({ type: 'qu.sync.response', reqId: msg.reqId, qubits: visible });

      // Reciprocate once: pull the same topic back from the requester, so a
      // single sync() call on reconnect flushes both directions. Guarded by
      // `reciprocal: false` on the request we send so it can't bounce again.
      if (msg.reciprocal !== false) {
        this.#request(msg.topic, this.#lastSync.get(msg.topic) ?? 0, { reciprocal: false })
          .then((r) => this.#lastSync.set(msg.topic, r.cursor))
          .catch((e) => debug('replication', 'reciprocal-sync-failed', { topic: msg.topic, error: e.message })); // best-effort; a failed reciprocation doesn't fail the original request
      }
      return;
    }

    if (msg.type === 'qu.sync.response') {
      const resolver = this.#pending.get(msg.reqId);
      if (resolver) { this.#pending.delete(msg.reqId); resolver(msg.qubits); }
      return;
    }

    if (msg.type === 'qu.has') {
      // "Do you already have qubit `id`?" — see hasRemote()'s doc below for
      // why this exists. Gated by the same read-ACL as everything else this
      // class serves (#isVisible == filterForReader), so this can't be used
      // as a free existence-oracle for ids the requester has no read access
      // to — same principle as #maybePush/#handleMessage's other branches.
      const q = await this.#runtime.get(msg.id);
      const has = !!q && (msg.ts == null || q.ts === msg.ts) && (await this.#isVisible(q));
      await this.#channel.send({ type: 'qu.has.response', reqId: msg.reqId, has });
      return;
    }

    if (msg.type === 'qu.has.response') {
      const resolver = this.#pending.get(msg.reqId);
      if (resolver) { this.#pending.delete(msg.reqId); resolver(msg.has); }
    }
  }

  async #genericRequest(message, timeoutMs) {
    const reqId = ++this.#reqId;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(reqId, resolve);
      setTimeout(() => { if (this.#pending.has(reqId)) { this.#pending.delete(reqId); reject(new Error('[DefaultReplication] request timed out')); } }, timeoutMs);
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
  async hasRemote(id, { ts = null, timeoutMs = 8000 } = {}) {
    return this.#genericRequest({ type: 'qu.has', id, ts }, timeoutMs);
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
  async waitUntilReplicated(id, { ts = null, intervalMs = 1000, maxWaitMs = 30000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        if (await this.hasRemote(id, { ts, timeoutMs: Math.min(8000, maxWaitMs) })) return true;
      } catch (e) {
        debug('replication', 'has-check-failed', { id, error: e.message });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  async #request(topic, since, { reciprocal = true } = {}) {
    const reqId = ++this.#reqId;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(reqId, resolve);
      setTimeout(() => { if (this.#pending.has(reqId)) { this.#pending.delete(reqId); reject(new Error('[DefaultReplication] sync request timed out')); } }, 10000);
    });
    debug('replication', 'sync-request', { topic, since, reciprocal });
    await this.#channel.send({ type: 'qu.sync.request', reqId, topic, since, reciprocal });
    const qubits = await p;
    let maxTs = since;
    for (const q of qubits) {
      this.#rememberFromPeer(q);
      try {
        await this.#runtime.ingest(q);
      } catch (e) {
        // One bad qubit in a sync batch (peer misbehaving, or a race with a
        // manifest change) must not abort the rest of the batch.
        debug('replication', 'sync-item-rejected', { id: q.id, error: e.message });
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
    this.#runtime.emit('sync.complete', { topic, cursor });
    return cursor;
  }

  async repair({ topic, since = this.#lastSync.get(topic) ?? 0 }) {
    const overlapSince = Math.max(0, since - this.#repairWindowMs);
    const { cursor } = await this.#request(topic, overlapSince);
    this.#lastSync.set(topic, Math.max(cursor, since));
    this.#runtime.emit('repair.complete', { topic, cursor });
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
    await this.#channel.send({ type: 'qu.subscribe', topic: String(topic) });
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

  listen() { /* already listening from constructor; exposed for interface symmetry */ }

  get peerFingerprint() { return this.#peerFingerprint; }
  get channelId() { return this.#channelId; }

  close() {
    this.#off();
    if (this.#offPush) this.#offPush();
    if (this.#router) this.#router.removeRoute(this.#channelId);
  }
}
