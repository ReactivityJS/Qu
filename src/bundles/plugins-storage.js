// Bundle 2/6 (Thema "storage") — browser storage adapters beyond Core's
// in-memory default: Web Storage (Local/Session) and IndexedDB, for both
// plain QuBits and file chunks. Depends only on src/adapters/** and the
// StorageAdapter/FileStorageAdapter contracts — no network, no modules.
export { LocalStorageAdapter } from '../adapters/local-storage.js';
export { SessionStorageAdapter } from '../adapters/session-storage.js';
export { WebStorageAdapter } from '../adapters/web-storage.js';
export { IndexedDBAdapter } from '../adapters/indexeddb.js';
export { MemoryFileStorageAdapter } from '../adapters/file-storage-memory.js';
export { IndexedDBFileStorageAdapter } from '../adapters/indexeddb-file-storage.js';
export { assertFileStorageAdapter } from '../data/files/contract.js';
