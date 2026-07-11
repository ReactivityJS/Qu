export class MemoryAdapter {
  #s = new Map();
  async get(id) { return this.#s.get(id) ?? null; }
  async put(id, q) { this.#s.set(id, q); }
  async delete(id) { this.#s.delete(id); }
  async getAll(prefix = '') {
    const r = [];
    for (const [k, v] of this.#s) if (k.startsWith(prefix)) r.push(v);
    return r;
  }
  async clear() { this.#s.clear(); }
}
