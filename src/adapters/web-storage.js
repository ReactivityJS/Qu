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

  /**
   * Ein leerer Namespace (siehe examples/space-app-browser.js's
   * `LocalStorageAdapter({ namespace: '' })`) bedeutet: dieser Adapter
   * teilt sich denselben Key-Raum mit JEDEM anderen Script auf derselben
   * Origin — einer Browser-Extension, einem anderen Tool, sogar einer
   * älteren, VOR diesem Adapter geschriebenen, nicht-JSON-Version desselben
   * Keys. `JSON.parse()` auf so einen fremden/kaputten Wert würde sonst die
   * gesamte aufrufende Kette hochwerfen (z. B. den kompletten App-Start,
   * wenn das beim initialen Laden von Kontakten/Räumen passiert) — behandelt
   * einen nicht parsbaren Wert stattdessen wie "nicht vorhanden" (mit
   * Warnung), genau wie ein fehlender Key auch.
   */
  async get(id) {
    const raw = this.#storage.getItem(this.#ns + id);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.warn(`[WebStorageAdapter] Wert unter "${this.#ns + id}" ist kein gültiges JSON, wird wie "nicht vorhanden" behandelt:`, e.message);
      return null;
    }
  }

  async put(id, q) { this.#storage.setItem(this.#ns + id, JSON.stringify(q)); }

  async delete(id) { this.#storage.removeItem(this.#ns + id); }

  /** Ein einzelner kaputter Eintrag (siehe get()s Doku) übersprungen statt die ganze Liste zum Scheitern zu bringen — die übrigen, gültigen Einträge bleiben nutzbar. */
  async getAll(prefix = '') {
    const out = [];
    const full = this.#ns + prefix;
    for (let i = 0; i < this.#storage.length; i++) {
      const key = this.#storage.key(i);
      if (!key.startsWith(full)) continue;
      try {
        out.push(JSON.parse(this.#storage.getItem(key)));
      } catch (e) {
        console.warn(`[WebStorageAdapter] Wert unter "${key}" ist kein gültiges JSON, wird übersprungen:`, e.message);
      }
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
