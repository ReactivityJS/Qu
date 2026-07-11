// StorageAdapter is a Core concept, same standing as Channel (see
// channel.js): the minimal contract QuStore is allowed to assume about
// "a place QuBits can be persisted (or not — see adapters/null.js)".
// Concrete adapters (Memory, LocalStorage, IndexedDB, Node:FS, ...) are
// Plugins that implement this contract — Core defines the shape, never a
// concrete backend.
//
//   get(id)              -> Promise<QuBit | null>
//   put(id, qubit)        -> Promise<void>
//   delete(id)             -> Promise<void>
//   getAll(prefix)          -> Promise<QuBit[]>    every stored QuBit whose id starts with `prefix`
//
// Duck-typed on purpose, exactly like assertChannel() — a mount fails
// loudly at registration time if it doesn't satisfy this, instead of
// failing confusingly on the first get()/put() three calls deep.
export function assertStorageAdapter(adapter) {
  const required = ['get', 'put', 'delete', 'getAll'];
  for (const m of required) {
    if (typeof adapter[m] !== 'function') {
      throw new Error(`[StorageAdapter] Object does not satisfy the StorageAdapter contract: missing "${m}"`);
    }
  }
  return adapter;
}
