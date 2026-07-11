import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * Chunks are already content-addressed by hash (§11) — a chunk's hash IS
 * its identity, so "one file per hash in a directory" is the natural,
 * simplest durable mapping. No index needed: hasChunk() is just
 * fs.access(), the filesystem itself is the index.
 */
export class FileSystemFileStorageAdapter {
  #dir;
  #ready;

  constructor(dir) {
    this.#dir = dir;
    this.#ready = fsp.mkdir(dir, { recursive: true });
  }

  #pathFor(hash) {
    // Guard against a hash containing path separators reaching fs calls —
    // real SHA-256 hex digests never do, but never trust input formed
    // from network-derived data without a check.
    if (!/^[a-f0-9]+$/i.test(hash)) throw new Error(`[FileSystemFileStorageAdapter] invalid chunk hash: ${hash}`);
    return path.join(this.#dir, hash);
  }

  async putChunk(hash, bytes) {
    await this.#ready;
    await fsp.writeFile(this.#pathFor(hash), bytes);
  }

  async getChunk(hash) {
    await this.#ready;
    try { return new Uint8Array(await fsp.readFile(this.#pathFor(hash))); } catch { return null; }
  }

  async hasChunk(hash) {
    await this.#ready;
    try { await fsp.access(this.#pathFor(hash)); return true; } catch { return false; }
  }

  async deleteChunk(hash) {
    await this.#ready;
    try { await fsp.unlink(this.#pathFor(hash)); } catch { /* already gone */ }
  }
}
