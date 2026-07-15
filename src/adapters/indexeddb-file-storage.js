// FileStorageAdapter over IndexedDB — browser-only, the file-chunk
// counterpart to indexeddb.js's QuBit-store adapter (same "one object
// store, wrapped IDBRequest→Promise" shape), kept as its own file because
// it satisfies a different contract (data/files/contract.js's
// putChunk/getChunk/hasChunk/deleteChunk, not core/storage.js's
// get/put/delete/getAll) — see file-storage-memory.js's own doc comment
// on why files never go through QuStore itself.
//
// Without this, a browser app has only MemoryFileStorageAdapter to hand
// to createFileHandlerPlugin()/DefaultFileTransfer — every downloaded
// chunk (an image, a video, ...) is gone on the next page load, forcing a
// full re-fetch from whichever peer/relay still has it, even for a file
// this exact browser already downloaded once. IndexedDBFileStorageAdapter
// is the persistent counterpart: `hasComplete()`/`missingChunks()`
// (data/files/manifest.js) then correctly see an already-downloaded chunk
// as already there across reloads, and never ask the network for it again.
const STORE = 'chunks';

function openDB(dbName) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDBFileStorageAdapter {
  #ready;

  constructor({ dbName = 'qu-files' } = {}) {
    this.#ready = openDB(dbName);
  }

  async #store(mode) {
    const db = await this.#ready;
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async putChunk(hash, bytes) { await wrap((await this.#store('readwrite')).put(bytes, hash)); }

  async getChunk(hash) {
    const result = await wrap((await this.#store('readonly')).get(hash));
    return result ?? null;
  }

  async hasChunk(hash) {
    const count = await wrap((await this.#store('readonly')).count(hash));
    return count > 0;
  }

  async deleteChunk(hash) { await wrap((await this.#store('readwrite')).delete(hash)); }
}
