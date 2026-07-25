import { WebStorageAdapter } from './web-storage.js';

// Same StorageAdapter shape as local-storage.js, over `sessionStorage`
// instead — tab-scoped, gone on close, otherwise identical semantics.
// Same import-vs-instantiate note as local-storage.js. Actual
// get/put/delete/getAll/clear logic lives in web-storage.js, shared with
// LocalStorageAdapter.
export class SessionStorageAdapter extends WebStorageAdapter {
  constructor(opts) { super(sessionStorage, opts); }
}
