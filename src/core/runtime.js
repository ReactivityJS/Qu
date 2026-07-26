import { QuPipeline } from './pipeline.js';
import { QuSubscriptionEngine } from './subscriptions.js';
import { QuClock } from './clock.js';
import { debug } from './debug.js';
import { subscribeWithOptions } from './subscribe-with-options.js';
import { assertValidPattern } from './pattern.js';

/**
 * The QU Runtime: Public API + Pipeline (Commit Engine) + QuStore + Dispatch/
 * Subscription Engine, exactly as drawn in the whitepaper diagram. It knows
 * nothing about identity, encryption, or permissions in the sense of *whose*
 * they are — Sessions own that. What Core DOES still do is verify signatures
 * and enforce write-ACLs, because both are checkable from public information
 * alone (a signature+pubKey either match a claimed writer or they don't; an
 * ACL either lists a writer or it doesn't) — no secret material required.
 *
 * There is deliberately only one write path: ingest(). A locally-authored,
 * already-signed qubit from a Session and a qubit that arrived from a peer
 * via Replication go through the exact same verify+ACL+store+dispatch
 * sequence, with no "trust this, it's local" shortcut. That symmetry is
 * what makes the Zero-Trust claim actually true instead of aspirational.
 */
export class QuRuntime {
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
    // A non-finite `ts` (NaN, +/-Infinity — reachable from any writer,
    // local or remote) breaks compareQubits()'s total order: both
    // `x < NaN` and `NaN < x` are false, so a NaN-ts qubit, once accepted
    // for an id, would unconditionally "win" against every future write to
    // that id, INCLUDING a stale replay with an old but valid ts — a
    // permanent LWW break for that id, not just a rejected one bad write.
    if (!Number.isFinite(qubit.ts)) {
      throw new Error(`[Runtime] ingest() rejected: non-finite ts (${qubit.ts}) for ${qubit.id}`);
    }
    const ctx = { qubit: { ...qubit }, requireSignature: false };
    try {
      await this.#pipeline.run(ctx, async () => {});
    } catch (e) {
      debug('runtime', 'ingest-rejected', { id: qubit.id, error: e.message });
      throw e;
    }
    const result = await this.#store.put(ctx.qubit);
    if (result.accepted && !result.noop) {
      debug('runtime', 'ingest-accepted', { id: ctx.qubit.id, ts: ctx.qubit.ts, writer: ctx.qubit.writer });
      this.#subs.publish(ctx.qubit);
    } else if (result.noop) {
      debug('runtime', 'ingest-noop', { id: ctx.qubit.id, ts: ctx.qubit.ts });
    } else {
      debug('runtime', 'ingest-superseded', { id: ctx.qubit.id, ts: ctx.qubit.ts });
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
    // Safe because assertValidPattern() (pattern.js) only accepts a `*`/`**`
    // as a whole path SEGMENT (never mid-segment, e.g. "a*b" is rejected) —
    // so the substring before the first `*` is always either the full
    // pattern (no wildcard) or a clean prefix ending right before a `/`,
    // which the trailing replace() then strips. This is only the store's
    // coarse pre-filter (see store.js's query() prefix matching below); the
    // regex test two lines down still does the real, precise match.
    const prefix = pattern.split(/[*]/)[0].replace(/\/$/, '');
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
      pattern, callback, ...opts,
    });
  }

  /** Ephemeral, unstored, unsigned event — for module-internal lifecycle signals, not data. */
  emit(topic, payload = {}) {
    this.#subs.publish({ id: topic, ...payload, ephemeral: true });
  }

  get store() { return this.#store; }
}

function patternToRegExp(pattern) {
  const escaped = pattern
    .split('/')
    .map((seg) => (seg === '**' ? '.*' : seg === '*' ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${escaped}$`);
}
