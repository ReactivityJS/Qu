// StorageAdapter over IndexedDB — browser-only (see local-storage.js for
// why this stays out of the barrel). One object store, keyed by the
// QuBit's own `id` (already unique and stable — same idea
// node-fs-file-storage.js uses a chunk's hash as its filename).
// getAll(prefix) uses a bounded key-range cursor instead of a full scan —
// the same "adapters that CAN filter efficiently should" reasoning
// core/store.js documents for why it passes a concrete prefix down.
const STORE = 'qubits';

function openDB(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Half-open range [prefix, prefix-with-last-char-incremented) — every id that starts with `prefix`, none that don't. */
function rangeFor(prefix) {
  if (!prefix) return undefined;
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return IDBKeyRange.bound(prefix, upper, false, true);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDBAdapter {
  #ready;

  constructor({ dbName = 'qu' } = {}) {
    this.#ready = openDB(dbName);
  }

  async #store(mode) {
    const db = await this.#ready;
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async get(id) {
    const result = await wrap((await this.#store('readonly')).get(id));
    return result ?? null;
  }

  async put(id, q) { await wrap((await this.#store('readwrite')).put(q)); }

  async delete(id) { await wrap((await this.#store('readwrite')).delete(id)); }

  async getAll(prefix = '') {
    const store = await this.#store('readonly');
    return new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor(rangeFor(prefix));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(out); return; }
        out.push(cursor.value);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clear() { await wrap((await this.#store('readwrite')).clear()); }
}
