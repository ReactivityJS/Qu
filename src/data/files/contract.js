// FileStorageAdapter is a distinct contract from StorageAdapter
// (core/storage.js): files are large, binary, and content-addressed (keyed
// by hash, not by id/path), so they're never stored through QuStore itself
// — see manifest.js's class doc. Same idea as core/storage.js's
// assertStorageAdapter()/core/channel.js's assertChannel(), scoped to the
// Data/Files plugin instead of Core, since only this plugin's own code
// (publishFile, DefaultFileTransfer) ever calls into a FileStorageAdapter.
export function assertFileStorageAdapter(adapter) {
  const required = ['putChunk', 'getChunk', 'hasChunk', 'deleteChunk'];
  for (const m of required) {
    if (typeof adapter[m] !== 'function') {
      throw new Error(`[FileStorageAdapter] Object does not satisfy the FileStorageAdapter contract: missing "${m}"`);
    }
  }
  return adapter;
}
