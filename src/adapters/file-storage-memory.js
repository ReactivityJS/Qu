// FileStorageAdapter is deliberately a different contract from
// StorageAdapter (core/store.js): files are large, binary, and
// content-addressed (keyed by hash, not by path), so they don't belong in
// the QuBit log itself — a FileManifest QuBit (small, signed, path-
// addressed) points at chunk hashes stored here. Same "Adapter" idea as
// storage/transport, applied to a different shape of data.
export class MemoryFileStorageAdapter {
  #chunks = new Map();
  async putChunk(hash, bytes) { this.#chunks.set(hash, bytes); }
  async getChunk(hash) { return this.#chunks.get(hash) ?? null; }
  async hasChunk(hash) { return this.#chunks.has(hash); }
  async deleteChunk(hash) { this.#chunks.delete(hash); }
}
