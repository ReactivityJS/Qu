// Shared implementation behind local-storage.js's LocalStorageAdapter and
// session-storage.js's SessionStorageAdapter — both wrap the exact same
// Web Storage API (getItem/setItem/removeItem/key/length), differing only
// in WHICH storage object they hand in (`localStorage` vs `sessionStorage`).
// Pulled out here instead of duplicated per file so the one place a caller
// might genuinely want to switch — durable-per-origin vs. gone-on-tab-close
// — really is just "which object do I pass in", not two independently
// maintained copies of the same get/put/delete/getAll/clear logic.
//
// Deliberately takes the raw Storage object as a constructor argument
// (not a global lookup) rather than exporting only the two named
// subclasses — so a caller with some OTHER thing shaped like the Web
// Storage API (a polyfill, a test double) can use this directly too,
// without needing a third near-identical file for it.
export class WebStorageAdapter {
  #storage;
  #ns;

  constructor(storage, { namespace = 'qu:' } = {}) {
    this.#storage = storage;
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

  /** Only this adapter's own namespace — other keys in the same Storage object (or from a different namespace on the same origin) are left untouched. */
  async clear() {
    const toRemove = [];
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (key.startsWith(this.#ns)) toRemove.push(key);
    }
    toRemove.forEach((k) => this.#storage.removeItem(k));
  }
}
