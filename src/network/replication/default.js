import { assertChannel } from '../../core/channel.js';
import { filterForReader } from '../../core/acl.js';
import { debug } from '../../core/debug.js';

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

  constructor(runtime, channel, {
    getACL = async () => null,
    peerFingerprint = null,
    repairWindowMs = 5 * 60 * 1000,
    pushTopics = [],
    router = null, // optional — see core/router.js. Unset: identical behaviour to before the Router existed.
  } = {}) {
    this.#runtime = runtime;
    this.#channel = assertChannel(channel);
    this.#channelId = channel.id;
    this.#getACL = getACL;
    this.#peerFingerprint = peerFingerprint;
    this.#repairWindowMs = repairWindowMs;
    this.#pushTopics = pushTopics;
    this.#router = router;
    this.#off = channel.onMessage((msg) => this.#handleMessage(msg));
    if (pushTopics.length) this.#offPush = this.#runtime.on('**', (q) => this.#maybePush(q));
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
    if (msg.type === 'qu.push') {
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
      const rows = await this.#runtime.query(`${msg.topic}/**`);
      const inRange = rows.filter((q) => q.ts >= msg.since);
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
    }
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

  listen() { /* already listening from constructor; exposed for interface symmetry */ }

  get peerFingerprint() { return this.#peerFingerprint; }
  get channelId() { return this.#channelId; }

  close() {
    this.#off();
    if (this.#offPush) this.#offPush();
    if (this.#router) this.#router.removeRoute(this.#channelId);
  }
}
