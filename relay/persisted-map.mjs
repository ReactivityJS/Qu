import fs from 'node:fs';
import path from 'node:path';

/**
 * A `Map` (get/set/delete/has, plus size) backed by a single JSON file,
 * written synchronously on every mutation. Node-only (`node:fs`) — same
 * placement reasoning as node-ws-bridge.mjs: this is THIS deployment's
 * storage choice, not something relay.mjs itself should assume (it takes
 * a plain `Map`-like value, see createRelay()'s `pushSubscriptions` doc).
 *
 * Deliberately synchronous, not batched/debounced: a push subscription
 * changes maybe once per browser per month, not once per message — the
 * write cost here is irrelevant, and synchronous means a crash right
 * after `subscribe()` can never lose the just-written subscription to an
 * unflushed async write, unlike the qubit/file stores' own higher-
 * frequency, deliberately-batched persistence.
 */
export function createPersistedMap(filePath) {
  const map = new Map(loadInitial(filePath));

  function loadInitial(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      return Object.entries(JSON.parse(raw));
    } catch {
      return []; // missing file (first run) or corrupt — start empty rather than crash the relay over subscription bookkeeping
    }
  }

  function persist() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(map)));
  }

  return {
    get(key) { return map.get(key); },
    has(key) { return map.has(key); },
    set(key, value) { map.set(key, value); persist(); return this; },
    delete(key) { const had = map.delete(key); if (had) persist(); return had; },
    get size() { return map.size; },
  };
}
