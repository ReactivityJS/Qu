// QuStore: persists exactly the QuBit it's given. It never mutates, never
// decrypts, never interprets `value`. It resolves which adapter owns an id
// by longest-prefix mount match (same idea as the draft) and — unlike the
// draft's query(), which always did a full unfiltered adapter.getAll() scan
// — passes the concrete prefix down to the adapter so adapters that *can*
// filter efficiently (IndexedDB range cursor, SQL WHERE, etc.) are able to.
import { assertStorageAdapter } from './storage.js';

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

  /** Writes only if the incoming qubit is newer (or equal, idempotent) than what's stored. Never overwrites a newer local record — this is the immutability boundary. */
  async put(qubit) {
    const mount = this.#resolve(qubit.id);
    const existing = await mount.adapter.get(qubit.id);
    if (existing && existing.ts > qubit.ts) return { accepted: false, existing };
    if (existing && existing.ts === qubit.ts) return { accepted: true, existing, noop: true };
    await mount.adapter.put(qubit.id, qubit);
    return { accepted: true };
  }

  async query(prefix) {
    const seen = new Set();
    const results = [];
    for (const m of this.#mounts) {
      if (seen.has(m.adapter)) continue;
      // Only ask adapters whose prefix could plausibly contain matches for this query prefix.
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
