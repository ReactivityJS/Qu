// UI bindings: the reactive-component layer the interactive Lab's views
// (docs/lab/labs/05-references-practice.mjs) build on. Pure DOM contract,
// zero framework, zero vdom — a "view" is nothing more than qu.on()'s live
// delivery wired to a render callback, and unmounting it is nothing more
// than that subscription's own unsubscribe. A "binding" (two-way) is the
// same view plus a local edit listener that writes back.
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
 * One-way, a single QuBit: `render(value, qubit)` runs once for whatever's
 * already there (if anything — `initial: true`), then again on every
 * future change. Dedup is by (id, ts), not deep value equality — the same
 * idea QuStore.put()'s same-ts-noop check and DefaultReplication's
 * de-echo cache already use elsewhere: a qubit's ts already uniquely
 * identifies "this exact write", cheaper and more precise than
 * re-comparing values on every delivery.
 */
export function viewKey(qu, id, render) {
  let lastTs = null;
  return qu.on(id, (q) => {
    if (q.ts === lastTs) return;
    lastTs = q.ts;
    render(q.value, q);
  }, { initial: true });
}

/**
 * One-way, a collection: every QuBit directly under `prefix` (one segment
 * further by default — the same "direct children only" shape data/
 * references.js's obj:// uses; pass a different `pattern` for anything
 * else) gets its own item via `createItem(qubit)` (called once, the first
 * time that key is seen) and `render(item, value, qubit)` (called on
 * first render and every update). `key(qubit)` picks the item identity
 * (default: `qubit.id`). Same (id, ts)-per-item dedup as viewKey.
 *
 * `createItem`'s return value is opaque to this function — typically a
 * DOM element the caller has already inserted into a container, but
 * nothing here assumes that; a caller that just wants the raw qubits
 * (e.g. to feed a table library) can return whatever it likes.
 */
export function viewObject(qu, prefix, { createItem, render, key = (q) => q.id, pattern = `${prefix}/*` }) {
  const items = new Map(); // key -> { item, ts }
  const off = qu.on(pattern, (q) => {
    const k = key(q);
    let entry = items.get(k);
    if (entry && entry.ts === q.ts) return;
    if (!entry) {
      entry = { item: createItem(q), ts: null };
      items.set(k, entry);
    }
    entry.ts = q.ts;
    render(entry.item, q.value, q);
  }, { initial: true });
  return () => { off(); items.clear(); };
}

const DEFAULT_ELEMENT_IO = {
  get: (el) => ('value' in el ? el.value : el.textContent),
  set: (el, v) => { if ('value' in el) el.value = v; else el.textContent = v; },
  event: 'input',
};

/**
 * Two-way, a single QuBit: the same live render as viewKey, plus a local
 * edit listener that publishes back. `event`/`get`/`set` default to
 * `<input>`/`<textarea>` (`.value`) or fall back to `.textContent` (works
 * for a contenteditable) — override for anything else.
 *
 * Both halves of the echo problem are guarded explicitly, never by
 * suppressing the subscription or the listener wholesale (that would just
 * trade one class of bug for another — genuinely-remote changes must
 * still come through):
 *   - write-side: an edit whose value already equals what's known locally
 *     is never published — no pointless write, no wasted clock tick.
 *   - render-side: the qubit THIS binding itself just published must not
 *     re-render (would stomp the input's cursor/selection with a value it
 *     already has) — a DIFFERENT binding to the SAME id (another open
 *     tab, another user) still re-renders normally; only the originating
 *     one skips its own echo.
 *
 * The publish's `ts` is computed up front (`qu.runtime.nextTs()`) and
 * compared against incoming qubits, rather than compared only after
 * `qu.publish()` resolves — Runtime dispatches to subscribers
 * *synchronously* during `ingest()` (see core/runtime.js), before the
 * `publish()` promise chain has even returned to this function, so
 * recording the ts only after `await qu.publish()` would miss its own
 * first echo. `onError`, if given, is called (and the local value
 * optimistically reverted) if the write itself is rejected (e.g. an ACL
 * denial) — the element's displayed value rolls back to what it was
 * before the edit rather than silently keeping an unsaved value.
 */
export function bindKey(qu, id, element, { get = DEFAULT_ELEMENT_IO.get, set = DEFAULT_ELEMENT_IO.set, event = DEFAULT_ELEMENT_IO.event, onError } = {}) {
  let lastValue;
  let lastOwnTs = null;

  const off = qu.on(id, (q) => {
    if (q.ts === lastOwnTs) return; // our own write echoing back — already reflected locally
    lastValue = q.value;
    set(element, q.value);
  }, { initial: true });

  const onInput = async () => {
    const value = get(element);
    if (value === lastValue) return; // identical value — nothing to write
    const previous = lastValue;
    lastValue = value;
    const ts = qu.runtime.nextTs();
    lastOwnTs = ts; // before publish(), not after — see class doc on why
    try {
      await qu.publish(id, value, { ts });
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
 * each its own leaf QuBit (`${prefix}/${field}`) — the same "individual
 * leaf QuBits, not one combined object" shape `qu.js`'s `publishProfile()`
 * already uses, so each field is independently writable/readable/ACL'able,
 * and two people editing different fields of the same record never
 * collide on one LWW register. `fields`: `{ [fieldName]: element }`.
 */
export function bindObject(qu, prefix, fields, opts = {}) {
  const offs = Object.entries(fields).map(([field, element]) => bindKey(qu, `${prefix}/${field}`, element, opts));
  return () => offs.forEach((off) => off());
}
