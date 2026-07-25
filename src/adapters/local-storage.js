import { WebStorageAdapter } from './web-storage.js';

// StorageAdapter over the Web Storage API (`localStorage`) — durable per
// origin, synchronous under the hood but wrapped in the same async
// contract as every other adapter. Importing this file is safe anywhere
// (no top-level browser global reference); only INSTANTIATING it needs a
// real `localStorage`, since `localStorage` doesn't exist in Node — same
// reasoning the Node:FS adapters follow in the other direction. Actual
// get/put/delete/getAll/clear logic lives in web-storage.js, shared with
// SessionStorageAdapter.
export class LocalStorageAdapter extends WebStorageAdapter {
  constructor(opts) { super(localStorage, opts); }
}
