import { sha256Hex } from '../../core/bytes.js';
import { debug } from '../../core/debug.js';
import { assertFileStorageAdapter } from './contract.js';

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KiB
const YIELD_EVERY_N_CHUNKS = 8; // give the event loop (and the WebSocket connection's own housekeeping) room to breathe on a long file

function splitChunks(bytes, chunkSize) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize));
  }
  if (bytes.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Chunks `bytes`, hashes each chunk (content-addressing — free dedup and
 * free integrity checking, see whitepaper §11), stores them in
 * `fileStorage`, and publishes a small FileManifest QuBit at `id` through
 * the given Session — an ordinary signed QuBit, so it replicates via the
 * existing Replication module with no extra code (whitepaper §11).
 *
 * `id` is caller-chosen and typically lives *inside* whatever Space the
 * surrounding content belongs to (e.g. `${roomSpaceId}/files/${fileId}`) —
 * there is no separate built-in "files Space"; a file inherits the ACL of
 * wherever its manifest is placed, exactly like any other QuBit (§8).
 */
export async function publishFile(session, id, bytes, { name, mime = 'application/octet-stream', chunkSize = DEFAULT_CHUNK_SIZE, fileStorage, refs, encryptFor } = {}) {
  if (!fileStorage) throw new Error('[publishFile] fileStorage (a FileStorageAdapter) is required');
  assertFileStorageAdapter(fileStorage);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunks = splitChunks(data, chunkSize);
  debug('files', 'chunking-start', { id, size: data.length, chunkCount: chunks.length });
  const hashes = [];
  for (let i = 0; i < chunks.length; i++) {
    const hash = await sha256Hex(chunks[i]);
    await fileStorage.putChunk(hash, chunks[i]);
    hashes.push(hash);
    if (i % YIELD_EVERY_N_CHUNKS === 0) await yieldToEventLoop();
  }
  const manifest = { name, mime, size: data.length, chunkSize, chunks: hashes };
  const result = await session.publish(id, manifest, { refs, encryptFor });
  debug('files', 'chunking-complete', { id, chunkCount: chunks.length });
  return { manifestId: id, manifest, ...result };
}

/** Concatenates chunks in manifest order. Returns null if any chunk is missing locally (use FileTransfer to fetch the rest first). */
export async function reassembleFile(fileStorage, manifest) {
  const parts = [];
  let total = 0;
  for (const hash of manifest.chunks) {
    const chunk = await fileStorage.getChunk(hash);
    if (!chunk) return null;
    parts.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** Which of a manifest's chunk hashes are NOT yet present in `fileStorage`. */
export async function missingChunks(fileStorage, manifest) {
  const missing = [];
  for (const hash of manifest.chunks) {
    if (!(await fileStorage.hasChunk(hash))) missing.push(hash);
  }
  return missing;
}
