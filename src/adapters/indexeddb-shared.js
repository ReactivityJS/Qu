// Shared plumbing for the two IndexedDB adapters (indexeddb.js's QuBit
// store, indexeddb-file-storage.js's chunk store) — both wrap the same
// callback-based IndexedDB API into promises the exact same way, so that
// wrapping lives here once instead of drifting between two copies (e.g. a
// future fix to error handling in `wrapIDBRequest()` would otherwise need
// to land twice, and easily wouldn't).

/** Opens (and, on first use, upgrades) a single-object-store IndexedDB database. */
export function openIndexedDB(dbName, upgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Fires instead of onsuccess/onupgradeneeded if another tab holds an
    // older-version connection open — this promise (and every adapter
    // method awaiting it) would otherwise hang forever with zero
    // diagnostic. Not resolved/rejected here on purpose: the browser keeps
    // waiting for the other tab to close/upgrade too, and may still
    // succeed once it does — this is only a visibility improvement, not a
    // behavior change, so a caller who needs a hard failure/timeout for
    // this case still has to add one themselves.
    req.onblocked = () => console.warn(`[IndexedDB] open("${dbName}") blocked by another open connection (e.g. another tab) — waiting for it to close.`);
  });
}

/** Wraps an IDBRequest's onsuccess/onerror callbacks into a promise. */
export function wrapIDBRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
