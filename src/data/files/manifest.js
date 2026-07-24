import { sha256Hex } from '../../core/bytes.js';
import { debug } from '../../core/debug.js';
import { assertFileStorageAdapter } from './contract.js';
import { encryptFor as encryptValueFor, decryptWith, encryptBytesFor, decryptBytesWith } from '../../core/crypto.js';

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
 *
 * `encryptFor`, if given, encrypts the file's actual BYTES
 * (core/crypto.js's encryptBytesFor(), same ECDH+HKDF multi-recipient
 * wrapping as any other encryptFor — the wrapped content key +
 * iv/salt/alg live in the manifest's own `contentEncryption` field)
 * before chunking, so the chunks stored in `fileStorage`/mirrored by a
 * relay are ciphertext, not plaintext. Trade-off, by necessity: chunk
 * hashes are content-addressed on CIPHERTEXT now, and encryption uses a
 * fresh random key per upload, so identical files no longer dedup across
 * uploads the way plaintext ones still do (dedup and per-recipient
 * encryption are fundamentally at odds — encrypting the same bytes for
 * the same or different recipients produces different ciphertext each
 * time). Omitting `encryptFor` (the framework-level default) keeps
 * today's plaintext, dedup-friendly behavior exactly as before — this is
 * opt-in, not a breaking change.
 *
 * `name`/`mime`/`size` are ALSO encrypted when `encryptFor` is given — a
 * filename alone can be plenty revealing ("Kündigung.pdf",
 * "IMG_Passbild.jpg"). They're encrypted SEPARATELY from the content
 * (core/crypto.js's ordinary JSON encryptFor(), not encryptBytesFor()) —
 * a small ciphertext stored in the manifest's own `metaEncryption` field
 * — specifically so a UI can show a real filename/type/size (readFileMeta()
 * below) WITHOUT first downloading and decrypting the entire file, which
 * could be large. Only `chunkSize`/`chunks` stay in the clear on the
 * manifest itself when encrypted.
 *
 * The MANIFEST QuBit itself is deliberately published UNENCRYPTED,
 * always — NOT forwarded to session.publish() the way an ordinary
 * encryptFor write would be. data/files/transfer.js's DefaultFileTransfer
 * reads a manifest's `chunks` (the hash list — which chunks to even
 * fetch) via RAW runtime access, one layer below Session's decrypt step
 * (it has no identity to decrypt with — chunk transfer is deliberately
 * agnostic to what's inside a chunk). An encrypted manifest QuBit would
 * make `.chunks` invisible to that raw read and break file transfer
 * entirely, for sender and recipient alike — encrypting name/mime/size
 * as their OWN separate fields (metaEncryption/contentEncryption) inside
 * an otherwise-plaintext manifest sidesteps that without touching the
 * transfer protocol at all.
 *
 * `onProgress`, if given, is called synchronously-ish during the
 * (potentially slow — think a phone video, hundreds of MB) local
 * encrypt+chunk+hash+store work below, purely so a UI can show something
 * better than a frozen spinner: once with `{ phase: 'encrypting' }` right
 * before the (single, not itself progress-reportable) content encryption
 * call, then with `{ phase: 'chunking', done, total }` after each chunk is
 * hashed and stored. This is LOCAL progress only — nothing here reports
 * on whether the relay/recipient has received anything yet; see
 * DefaultFileTransfer's `waitUntilReady()` for that.
 */
export async function publishFile(session, id, bytes, { name, mime = 'application/octet-stream', chunkSize = DEFAULT_CHUNK_SIZE, fileStorage, refs, encryptFor, onProgress } = {}) {
  if (!fileStorage) throw new Error('[publishFile] fileStorage (a FileStorageAdapter) is required');
  assertFileStorageAdapter(fileStorage);
  let data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const plainSize = data.length;

  let contentEncryption;
  let metaEncryption;
  if (encryptFor && encryptFor.length) {
    onProgress?.({ phase: 'encrypting' });
    const recipients = await session.resolveEncryptionRecipients(encryptFor);
    const { envelope, ciphertext } = await encryptBytesFor(recipients, data);
    contentEncryption = envelope;
    data = ciphertext;
    // `size` bleibt die KLARTEXT-Größe (für eine sinnvolle Anzeige, "3.2 MB"
    // statt der um den AES-GCM-Auth-Tag leicht größeren Chiffretext-Länge)
    // — reassembleFile() liefert ohnehin wieder Klartext-Bytes zurück, die
    // tatsächlich gespeicherte/übertragene Chunk-Summe darf davon abweichen.
    metaEncryption = await encryptValueFor(recipients, { name, mime, size: plainSize });
  }

  const chunks = splitChunks(data, chunkSize);
  debug('files', 'chunking-start', { id, size: data.length, chunkCount: chunks.length, encrypted: !!contentEncryption });
  onProgress?.({ phase: 'chunking', done: 0, total: chunks.length });
  const hashes = [];
  for (let i = 0; i < chunks.length; i++) {
    const hash = await sha256Hex(chunks[i]);
    await fileStorage.putChunk(hash, chunks[i]);
    hashes.push(hash);
    onProgress?.({ phase: 'chunking', done: i + 1, total: chunks.length });
    if (i % YIELD_EVERY_N_CHUNKS === 0) await yieldToEventLoop();
  }
  const manifest = { chunkSize, chunks: hashes };
  if (contentEncryption) {
    manifest.contentEncryption = contentEncryption;
    manifest.metaEncryption = metaEncryption;
  } else {
    manifest.name = name;
    manifest.mime = mime;
    manifest.size = plainSize;
  }
  const result = await session.publish(id, manifest, { refs, encryptFor: null }); // siehe Doku oben — muss für DefaultFileTransfer roh lesbar bleiben
  debug('files', 'chunking-complete', { id, chunkCount: chunks.length });
  return { manifestId: id, manifest, ...result };
}

/**
 * `{ name, mime, size }` for a manifest — decrypts `metaEncryption` if
 * present (needs `identity`; throws if omitted, same reasoning as
 * reassembleFile()), otherwise just reads the plaintext fields directly.
 * Deliberately independent of the file's actual content/chunks — a UI
 * can show a real filename, type, and size immediately (e.g. while a
 * large attachment is still downloading) instead of only after
 * reassembling and decrypting the whole thing. `undefined` if `identity`
 * is valid but isn't among the file's recipients (same convention as
 * core/crypto.js's decryptWith()/decryptBytesWith()).
 */
export async function readFileMeta(manifest, identity = null) {
  if (!manifest.metaEncryption) return { name: manifest.name, mime: manifest.mime, size: manifest.size };
  if (!identity) throw new Error('[readFileMeta] this file\'s metadata is encrypted (manifest.metaEncryption) — an identity is required to decrypt it');
  return decryptWith(identity, manifest.metaEncryption);
}

/**
 * Concatenates chunks in manifest order, then decrypts if the manifest
 * carries `contentEncryption` (publishFile()'s doc above). Returns null
 * if any chunk is missing locally (use FileTransfer to fetch the rest
 * first) — same as always. For an encrypted file, `identity` is required
 * to decrypt; omitting it throws rather than silently returning
 * ciphertext, which would look like a corrupt file to any caller
 * expecting real bytes back. Returns `undefined` if `identity` is valid
 * but simply isn't among the file's recipients — same convention as
 * core/crypto.js's decryptWith()/decryptBytesWith().
 */
export async function reassembleFile(fileStorage, manifest, identity = null) {
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

  if (!manifest.contentEncryption) return out;
  if (!identity) throw new Error('[reassembleFile] this file is encrypted (manifest.contentEncryption) — an identity is required to decrypt it');
  return decryptBytesWith(identity, manifest.contentEncryption, out);
}

/** Which of a manifest's chunk hashes are NOT yet present in `fileStorage`. */
export async function missingChunks(fileStorage, manifest) {
  const missing = [];
  for (const hash of manifest.chunks) {
    if (!(await fileStorage.hasChunk(hash))) missing.push(hash);
  }
  return missing;
}
