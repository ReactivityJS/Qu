// StorageAdapter over the Web Storage API (`localStorage`) — durable per
// origin, synchronous under the hood but wrapped in the same async
// contract as every other adapter. Browser-only: `localStorage` doesn't
// exist in Node, so this file is never imported by src/index.js's barrel —
// same reasoning as the Node:FS adapters staying out of it, just mirrored
// for the browser side.
export class LocalStorageAdapter {
  #storage;
  #ns;

  constructor({ namespace = 'qu:' } = {}) {
    this.#storage = localStorage;
    this.#ns = namespace;
  }

  async get(id) {
    const raw = this.#storage.getItem(this.#ns + id);
    return raw === null ? null : JSON.parse(raw);
  }

  async put(id, q) { this.#storage.setItem(this.#ns + id, JSON.stringify(q)); }

  async delete(id) { this.#storage.removeItem(this.#ns + id); }

  async getAll(prefix = '') {
    const out = [];
    const full = this.#ns + prefix;
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(full)) out.push(JSON.parse(this.#storage.getItem(key)));
    }
    return out;
  }

  /** Only this adapter's own namespace — other localStorage keys on the same origin are left untouched. */
  async clear() {
    const toRemove = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(this.#ns)) toRemove.push(key);
    }
    toRemove.forEach((k) => this.#storage.removeItem(k));
  }
}
