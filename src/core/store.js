// QuStore: persists exactly the QuBit it's given. It never mutates, never
// decrypts, never interprets `value`. It resolves which adapter owns an id
// by longest-prefix mount match (same idea as the draft) and — unlike the
// draft's query(), which always did a full unfiltered adapter.getAll() scan
// — passes the concrete prefix down to the adapter so adapters that *can*
// filter efficiently (IndexedDB range cursor, SQL WHERE, etc.) are able to.
import { assertStorageAdapter } from './storage.js';

/**
 * Total order between two QuBits for the same id: `ts` first, `writer`
 * (lexicographic) as a deterministic tiebreaker. Two DIFFERENT qubits can
 * legitimately share the exact same `ts` — core/clock.js's HLC guarantees
 * uniqueness only within one Runtime's own clock instance, not across two
 * independently-clocked devices/replicas. Without a tiebreaker, "which one
 * wins" fell back to "whichever happened to be seen first by THIS
 * particular store" (QuStore.put()'s own `ts === ts` branch) or "whichever
 * line comes last in the log" (FileSystemStorageAdapter's reload
 * reconciliation) — two different replicas (or the same one before/after a
 * restart) could then disagree forever about which of the two qubits
 * "won". Comparing `writer` too makes the result a pure function of the
 * two qubits' own content, identical everywhere regardless of arrival
 * order or process history — every place that decides qubit precedence
 * (QuStore.put(), FileSystemStorageAdapter's log reconciliation, and any
 * future StorageAdapter that needs the same decision) uses this one
 * function rather than re-deriving its own rule.
 *
 * Returns <0 if `a` loses to `b`, 0 if they're equivalent (same id, ts,
 * and writer — a true duplicate delivery), >0 if `a` wins.
 */
export function compareQubits(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const aw = a.writer ?? '';
  const bw = b.writer ?? '';
  if (aw !== bw) return aw < bw ? -1 : 1;
  return 0;
}

export class QuStore {
  #mounts = []; // [{ prefix, adapter, replicate }], sorted longest-prefix-first

  constructor(mounts) {
    this.#mounts = [...mounts]
      .map((m) => ({ replicate: true, ...m, adapter: assertStorageAdapter(m.adapter) }))
      .sort((a, b) => b.prefix.length - a.prefix.length);
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
    const seen = new Set();
    const results = [];
    for (const m of this.#mounts) {
      if (seen.has(m.adapter)) continue;
      // Only ask adapters whose prefix could plausibly contain matches for this query prefix.
      // Bidirectional on purpose — either side can be the more specific one:
      // mount "a/b", query prefix "a"     -> "a".startsWith("a/b")     is false,
      //                                       but "a/b".startsWith("a") is true  -> asked (mount is inside the query).
      // mount "a/b", query prefix "a/b/c" -> "a/b/c".startsWith("a/b") is true   -> asked (query is inside the mount).
      // mount "a/b", query prefix "x"     -> neither startsWith() holds         -> skipped.
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
}
