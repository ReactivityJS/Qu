// FileHandler: a thin `file://` wrapper around the existing File-Handling
// primitives (manifest.js's chunking/content-addressing, transfer.js's
// request/response protocol) — neither of those changes here, this file
// only adds the URI convention and ties it into ReferenceHandler (see
// ../references.js) so `file://<manifestId>` composes with `obj://`/`key://`
// the same way a foreign key composes with the rows it points at.
import { publishFile, reassembleFile, missingChunks } from './manifest.js';
import { DefaultFileTransfer } from './transfer.js';
import { parseReference, fileRef } from '../references.js';

/** Chunks+publishes `bytes` exactly like the underlying publishFile(), plus the `file://` string to embed elsewhere (a chat message, a table cell, ...). */
export async function shareFile(qu, id, bytes, opts = {}) {
  if (qu.isGuest) throw new Error('[FileHandler] Guest-Sessions haben kein Schreibrecht (versucht: shareFile). Mit Qu.create({ identity }) eine echte Identität verwenden.');
  const result = await publishFile(qu.session, id, bytes, opts);
  return { ...result, fileRef: fileRef(result.manifestId) };
}

/**
 * Dereferences a `file://<manifestId>` string to the file's bytes. Fetches
 * any chunks missing from `fileStorage` via `fileTransfer.requestFile()`
 * first (throws if chunks are missing and no fileTransfer was supplied —
 * there is nowhere else to get them from), then reassembles locally.
 */
export async function resolveFileRef(qu, fileStorage, ref, { fileTransfer = null } = {}) {
  const { scheme, path: manifestId } = parseReference(ref);
  if (scheme !== 'file') throw new Error(`[FileHandler] Not a file:// reference: ${ref}`);
  const qubit = await qu.get(manifestId);
  if (!qubit) throw new Error(`[FileHandler] No manifest found for ${manifestId}`);
  const manifest = qubit.value;
  const missing = await missingChunks(fileStorage, manifest);
  if (missing.length) {
    if (!fileTransfer) throw new Error(`[FileHandler] ${missing.length} chunk(s) missing locally for ${manifestId} and no fileTransfer was supplied to fetch them`);
    await fileTransfer.requestFile(manifestId);
  }
  return reassembleFile(fileStorage, manifest, qu.identity);
}

function isBytesLike(value) {
  return value instanceof Uint8Array
    || (typeof Blob !== 'undefined' && value instanceof Blob)
    || (typeof File !== 'undefined' && value instanceof File);
}

/**
 * `qu.use(createFileHandlerPlugin({ fileStorage }))` — attaches:
 *   - `qu.shareFile(id, bytes, opts)` — defaults `opts.fileStorage` to this
 *     plugin's `fileStorage` (still overridable per call).
 *   - `qu.resolveFileRef(ref, opts)` — dereferences against this
 *     `fileStorage`; `opts.fileTransfer`, if given, fetches missing chunks.
 *   - `qu.fileTransfer(channel, fileStorage = this plugin's, opts)` — same
 *     signature as the underlying `DefaultFileTransfer` constructor, with
 *     `getACL` wired to this Qu instance's ACL resolver automatically.
 *   - a `setPutHandler()` upgrade so `qu.get(id).put(bytes, opts)` auto-detects
 *     Uint8Array/Blob/File and routes through `shareFile()` (chunk+manifest)
 *     instead of the Core default, which throws on file-shaped values (see
 *     qu.js's `defaultPutDispatch`).
 * Also directly usable as `references.js`'s `fileHandler` option (it
 * already exposes a matching `resolveFileRef(qu, ref)`), so
 * `qu.use(createReferenceHandlerPlugin({ fileHandler:
 * createFileHandlerPlugin({ fileStorage }) }))` makes `file://` refs
 * resolve to real bytes instead of a raw manifest.
 */
export function createFileHandlerPlugin({ fileStorage } = {}) {
  if (!fileStorage) throw new Error('[FileHandler] fileStorage (a FileStorageAdapter) is required');
  const handler = {
    fileStorage,
    shareFile: (qu, id, bytes, opts) => shareFile(qu, id, bytes, { fileStorage, ...opts }),
    resolveFileRef: (qu, ref, opts) => resolveFileRef(qu, fileStorage, ref, opts),
    install(qu) {
      qu.shareFile = (id, bytes, opts) => handler.shareFile(qu, id, bytes, opts);
      qu.resolveFileRef = (ref, opts) => handler.resolveFileRef(qu, ref, opts);
      qu.fileTransfer = (channel, storage = fileStorage, opts = {}) => new DefaultFileTransfer(qu.runtime, channel, storage, { getACL: qu.acl, ...opts });
      qu.setPutHandler(async (session, id, value, opts) => {
        if (!isBytesLike(value)) return session.publish(id, value, opts);
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(await value.arrayBuffer());
        const name = opts?.name ?? value.name;
        const mime = opts?.mime ?? value.type;
        return handler.shareFile(qu, id, bytes, { name, mime, ...opts });
      });
    },
  };
  return handler;
}
