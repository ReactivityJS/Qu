// Same StorageAdapter shape as local-storage.js, over `sessionStorage`
// instead — tab-scoped, gone on close, otherwise identical semantics.
// Browser-only, kept out of the barrel (see local-storage.js).
export class SessionStorageAdapter {
  #storage;
  #ns;

  constructor({ namespace = 'qu:' } = {}) {
    this.#storage = sessionStorage;
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

  async clear() {
    const toRemove = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(this.#ns)) toRemove.push(key);
    }
    toRemove.forEach((k) => this.#storage.removeItem(k));
  }
}
