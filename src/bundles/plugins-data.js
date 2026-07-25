// Bundle 2/6 (Thema "data") — references (obj://, key://, file://) and
// the chunked file-transfer pipeline built on top of them. Depends on
// Core plus plugins-storage.js's FileStorageAdapter contract (bring your
// own file storage adapter — this bundle doesn't include one).
export {
  isReference, parseReference, objRef, keyRef, fileRef,
  resolveReference, resolveValue, createReferenceHandlerPlugin,
} from '../data/references.js';
export { publishFile, reassembleFile, missingChunks, readFileMeta } from '../data/files/manifest.js';
export { DefaultFileTransfer } from '../data/files/transfer.js';
export { shareFile, resolveFileRef, createFileHandlerPlugin } from '../data/files/index.js';
