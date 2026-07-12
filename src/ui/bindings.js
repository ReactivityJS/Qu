// UI bindings: the reactive-component layer the interactive Lab's views
// (docs/lab/labs/05-references-practice.mjs) build on. Pure DOM contract,
// zero framework, zero vdom — a "view" is nothing more than a node's live
// on()/map() delivery wired to a render callback, and unmounting it is
// nothing more than that subscription's own unsubscribe. A "binding"
// (two-way) is the same view plus a local edit listener that writes back.
//
// Every function here takes an already-navigated node (`qu.get(id)`, see
// core/space-handle.js) instead of a `(qu, id)` pair — one fewer parameter,
// composes directly with the rest of the get/put/set/on/map API: a caller
// writes `viewKey(qu.get(id), render)` or `bindKey(alice.own.get('bio'),
// input)`.
//
// Deliberately DOM-library-agnostic: nothing here calls document.* —
// `createItem`/`render`/element get-set are all supplied by the caller, so
// this file has zero browser dependency and is fully unit-testable with
// plain mock objects (see test/ui-bindings.test.mjs), the same way the
// rest of Core stays testable without a browser.
//
// One-way (viewKey/viewObject) is the basis two-way (bindKey/bindObject)
// builds on — a binding is a view with a write-listener added, not a
// separate mechanism.

/**
 * One-way, a single node: `render(value, qubit)` runs once for whatever's
 * already there (if anything — `initial: true`), then again on every
 * future change. Dedup is by (id, ts), not deep value equality — the same
 * idea QuStore.put()'s same-ts-noop check and DefaultReplication's
 * de-echo cache already use elsewhere: a qubit's ts already uniquely
 * identifies "this exact write", cheaper and more precise than
 * re-comparing values on every delivery.
 */
export function viewKey(node, render) {
  let lastTs = null;
  return node.on((q) => {
    if (q.ts === lastTs) return;
    lastTs = q.ts;
    render(q.value, q);
  }, { initial: true });
}

/**
 * One-way, a collection: every QuBit directly under `node` (or, with
 * `deep: true`, at any depth — the shape a `set()`-based collection like
 * chat messages needs, since it namespaces two segments deep) gets its own
 * item via `createItem(qubit)` (called once, the first time that key is
 * seen) and `render(item, value, qubit)` (called on first render and every
 * update). `key(qubit)` picks the item identity (default: `qubit.id`).
 * Same (id, ts)-per-item dedup as viewKey.
 *
 * `createItem`'s return value is opaque to this function — typically a
 * DOM element the caller has already inserted into a container, but
 * nothing here assumes that; a caller that just wants the raw qubits
 * (e.g. to feed a table library) can return whatever it likes.
 */
export function viewObject(node, { createItem, render, key = (q) => q.id, deep = false }) {
  const items = new Map(); // key -> { item, ts }
  const off = node.map((q) => {
    const k = key(q);
    let entry = items.get(k);
    if (entry && entry.ts === q.ts) return;
    if (!entry) {
      entry = { item: createItem(q), ts: null };
      items.set(k, entry);
    }
    entry.ts = q.ts;
    render(entry.item, q.value, q);
  }, { deep, initial: true });
  return () => { off(); items.clear(); };
}

// Exported so ui/components.js's <qu-view>/<qu-bind> can fall back to the
// exact same default instead of re-declaring the heuristic a second time.
export const DEFAULT_ELEMENT_IO = {
  get: (el) => ('value' in el ? el.value : el.textContent),
  set: (el, v) => { if ('value' in el) el.value = v; else el.textContent = v; },
  event: 'input',
};

/**
 * Two-way, a single node: the same live render as viewKey, plus a local
 * edit listener that writes back. `event`/`get`/`set` default to
 * `<input>`/`<textarea>` (`.value`) or fall back to `.textContent` (works
 * for a contenteditable) — override for anything else.
 *
 * Both halves of the echo problem are guarded explicitly, never by
 * suppressing the subscription or the listener wholesale (that would just
 * trade one class of bug for another — genuinely-remote changes must
 * still come through):
 *   - write-side: an edit whose value already equals what's known locally
 *     is never written — no pointless write, no wasted clock tick.
 *   - render-side: the qubit THIS binding itself just wrote must not
 *     re-render (would stomp the input's cursor/selection with a value it
 *     already has) — a DIFFERENT binding to the SAME id (another open
 *     tab, another user) still re-renders normally; only the originating
 *     one skips its own echo.
 *
 * The write's `ts` is computed up front (`node.runtime.nextTs()`) and
 * compared against incoming qubits, rather than compared only after
 * `node.put()` resolves — Runtime dispatches to subscribers
 * *synchronously* during `ingest()` (see core/runtime.js), before the
 * `put()` promise chain has even returned to this function, so recording
 * the ts only after `await node.put()` would miss its own first echo.
 * `onError`, if given, is called (and the local value optimistically
 * reverted) if the write itself is rejected (e.g. an ACL denial) — the
 * element's displayed value rolls back to what it was before the edit
 * rather than silently keeping an unsaved value.
 */
export function bindKey(node, element, { get = DEFAULT_ELEMENT_IO.get, set = DEFAULT_ELEMENT_IO.set, event = DEFAULT_ELEMENT_IO.event, onError } = {}) {
  let lastValue;
  let lastOwnTs = null;

  const off = node.on((q) => {
    if (q.ts === lastOwnTs) return; // our own write echoing back — already reflected locally
    lastValue = q.value;
    set(element, q.value);
  }, { initial: true });

  const onInput = async () => {
    const value = get(element);
    if (value === lastValue) return; // identical value — nothing to write
    const previous = lastValue;
    lastValue = value;
    const ts = node.runtime.nextTs();
    lastOwnTs = ts; // before put(), not after — see class doc on why
    try {
      await node.put(value, { ts });
    } catch (e) {
      lastValue = previous;
      lastOwnTs = null;
      set(element, previous ?? '');
      onError?.(e);
    }
  };
  element.addEventListener(event, onInput);

  return () => { off(); element.removeEventListener(event, onInput); };
}

/**
 * Two-way, multiple fields of one logical record: one bindKey() per field,
 * each its own leaf QuBit (`node.get(field)`) — individual leaf QuBits, not
 * one combined object, so each field is independently writable/readable/
 * ACL'able, and two people editing different fields of the same record
 * never collide on one LWW register. `fields`: `{ [fieldName]: element }`.
 */
export function bindObject(node, fields, opts = {}) {
  const offs = Object.entries(fields).map(([field, element]) => bindKey(node.get(field), element, opts));
  return () => offs.forEach((off) => off());
}
