import { debug } from './debug.js';
import { splitPath, assertValidPattern } from './pattern.js';

// Subscription Engine
//
// The v4.3.5 draft claimed "optimierte Subscription-Indizes" but actually
// stored subscriptions as a flat array and tested every regex on every
// publish (O(n) per event). This is a real index: a segment trie, the same
// idea MQTT uses for topic routing ('*' = one segment, '**' = this node and
// everything below it, regardless of remaining depth). publish() only walks
// the branches that can possibly match, instead of every subscriber.

class TrieNode {
  children = new Map(); // literal segment -> TrieNode
  starChild = null;     // '*' -> TrieNode
  exact = [];            // subs whose pattern ends exactly here
  deep = [];             // subs whose pattern has '**' here (matches this node + anything below)
}

export class QuSubscriptionEngine {
  #root = new TrieNode();
  #count = 0;

  subscribe(pattern, callback) {
    assertValidPattern(pattern);
    const segments = splitPath(pattern);
    let node = this.#root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === '**') {
        const entry = { callback, pattern };
        node.deep.push(entry);
        this.#count++;
        return () => {
          const idx = node.deep.indexOf(entry);
          if (idx !== -1) { node.deep.splice(idx, 1); this.#count--; }
        };
      }
      if (seg === '*') {
        node.starChild ??= new TrieNode();
        node = node.starChild;
      } else {
        let child = node.children.get(seg);
        if (!child) { child = new TrieNode(); node.children.set(seg, child); }
        node = child;
      }
    }
    const entry = { callback, pattern };
    node.exact.push(entry);
    this.#count++;
    return () => {
      const idx = node.exact.indexOf(entry);
      if (idx !== -1) { node.exact.splice(idx, 1); this.#count--; }
    };
  }

  once(pattern, callback) {
    const off = this.subscribe(pattern, (q) => { off(); callback(q); });
    return off;
  }

  get size() { return this.#count; }

  /** Returns the list of matching callbacks for a given qubit id, without invoking them. */
  match(id) {
    const segments = splitPath(id);
    const hits = [];
    const walk = (node, i) => {
      if (!node) return;
      if (node.deep.length) hits.push(...node.deep);
      if (i === segments.length) {
        if (node.exact.length) hits.push(...node.exact);
        return;
      }
      const seg = segments[i];
      walk(node.children.get(seg), i + 1);
      walk(node.starChild, i + 1);
    };
    walk(this.#root, 0);
    return hits;
  }

  publish(qubit) {
    for (const { callback } of this.match(qubit.id)) {
      try {
        const result = callback(qubit);
        // A subscriber can be async (DefaultReplication's push listener is
        // exactly this) — calling it doesn't throw synchronously even if it
        // will later reject, so a plain try/catch here does NOT catch that.
        // Before this fix, a rejection from one subscriber's async work
        // (e.g. a transient failure sending a file-manifest push) was a
        // silent unhandled rejection: not a crash in a browser, but the
        // push for that qubit — and potentially the listener's internal
        // state — could be left in a broken half-done state with no
        // visible error at all.
        if (result && typeof result.catch === 'function') {
          result.catch((e) => {
            debug('subscriptions', 'listener-error', { id: qubit.id, error: e.message });
            console.error(`[QuSubscriptionEngine] async listener error for ${qubit.id}:`, e);
          });
        }
      } catch (e) {
        debug('subscriptions', 'listener-error', { id: qubit.id, error: e.message });
        console.error(`[QuSubscriptionEngine] listener error for ${qubit.id}:`, e);
      }
    }
  }
}
