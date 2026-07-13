import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { compareQubits } from '../core/store.js';

/**
 * Persists QuBits to an append-only NDJSON log (one JSON line per write),
 * with an in-memory Map rebuilt from that log on startup — reads are O(1)
 * from memory, writes are an fs append (cheap, sequential) plus a map
 * update. This is what turns a relay from "forgets everything on restart"
 * into an actual mirror (§8 Sicherheitsmodell: the *contents* it mirrors
 * are still governed by the same Space ACLs as everywhere else — this
 * adapter has no opinion about that, it just persists whatever QuStore
 * hands it, same as MemoryAdapter, only durably).
 *
 * Not compacted — a QuBit with a superseding write (same id, higher ts)
 * still has its earlier line on disk. Fine for a demo/moderate-traffic
 * relay; a production deployment would want periodic log compaction
 * (rewrite the file from the in-memory map) or a real embedded DB. That's
 * swappable later without touching QuStore or anything above it — this is
 * exactly the StorageAdapter contract doing its job.
 */
export class FileSystemStorageAdapter {
  #filePath;
  #map = new Map();
  #ready;

  constructor(filePath) {
    this.#filePath = filePath;
    this.#ready = this.#load();
  }

  async #load() {
    await fsp.mkdir(path.dirname(this.#filePath), { recursive: true });
    let text = '';
    try { text = await fsp.readFile(this.#filePath, 'utf8'); } catch { /* no file yet */ }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const q = JSON.parse(line);
        const existing = this.#map.get(q.id);
        // compareQubits() (core/store.js) — same tiebreak QuStore.put() uses,
        // so reload reconciliation never disagrees with the live write path
        // about which of two same-`ts` qubits wins.
        if (!existing || compareQubits(q, existing) >= 0) this.#map.set(q.id, q);
      } catch { /* skip a corrupt line rather than fail startup */ }
    }
  }

  async get(id) {
    await this.#ready;
    return this.#map.get(id) ?? null;
  }

  async put(id, q) {
    await this.#ready;
    this.#map.set(id, q);
    await fsp.appendFile(this.#filePath, `${JSON.stringify(q)}\n`);
  }

  async delete(id) {
    await this.#ready;
    this.#map.delete(id);
    // Tombstones aren't written here — QuStore's immutability model has no
    // delete concept beyond "a newer QuBit superseded this one" (§3); a
    // real delete would need its own designed representation, not a gap
    // silently filled in by the adapter.
  }

  async getAll(prefix = '') {
    await this.#ready;
    const out = [];
    for (const [id, q] of this.#map) if (id.startsWith(prefix)) out.push(q);
    return out;
  }
}

/** Convenience: check whether a data directory already has content, for logging/diagnostics. */
export function dataDirExists(filePath) {
  return fs.existsSync(filePath);
}
