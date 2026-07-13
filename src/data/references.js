// ReferenceHandler: an optional, manual (not automatic/reactive — same
// philosophy as core/session.js's resolveRefs()) way to model relationships
// between QuBits with plain strings instead of raw ids, so a QuBit's value
// can point at other data without the reader needing to know Qu's storage
// layout up front:
//
//   key://<path>   — one QuBit's resolved value (a pointer, like a foreign key)
//   obj://<path>   — the *direct* children of <path> (one segment past the
//                    prefix, like `<path>/*`), collected into a plain object
//                    keyed by their last path segment — or, with
//                    `asArray: true`, sorted into a plain array. This is the
//                    mechanism for representing arrays/lists/tables: each
//                    row is its own QuBit under `<path>/<rowKey>`, and
//                    `obj://<path>` reconstructs the collection.
//   file://<manifestId> — delegates to a FileHandler (see data/files/index.js)
//                    if one is supplied, otherwise falls back to the raw
//                    FileManifest QuBit's value.
//
// Nesting deeper structures (a table whose rows themselves have list
// fields) is just one obj://|key:// ref inside another — depth is bounded
// by `maxDepth`, not by how the data happens to be shaped, and a `seen`
// guard makes a reference cycle resolve to the raw, unresolved ref string
// instead of hanging.

const REF_RE = /^(obj|key|file):\/\/(.+)$/;

export function isReference(value) {
  return typeof value === 'string' && REF_RE.test(value);
}

export function parseReference(ref) {
  const m = typeof ref === 'string' ? ref.match(REF_RE) : null;
  if (!m) throw new Error(`[References] Not a obj://|key://|file:// reference: ${JSON.stringify(ref)}`);
  return { scheme: m[1], path: m[2] };
}

export function objRef(path) { return `obj://${path}`; }
export function keyRef(path) { return `key://${path}`; }
export function fileRef(manifestId) { return `file://${manifestId}`; }

function lastSegment(id, prefix) {
  return id.slice(prefix.length).replace(/^\//, '').split('/')[0];
}

/** Resolves one obj://|key://|file:// string. `depth` is the budget available for cascading into *further* refs found inside the resolved value — resolving the reference passed in always happens regardless of `depth`. */
async function resolveOne(qu, ref, opts, seen, depth) {
  const { scheme, path } = parseReference(ref);

  if (scheme === 'key') {
    const qubit = await qu.get(path);
    if (!qubit) return undefined;
    return walk(qu, qubit.value, opts, seen, depth - 1);
  }

  if (scheme === 'obj') {
    // A one-shot array of matches, not a live subscription — the escape
    // hatch (qu.session.query()) rather than get(path).map(cb, {once}),
    // which is callback-shaped and has no "done" signal to await.
    const rows = await qu.session.query(`${path}/*`);
    const entries = await Promise.all(rows.map(async (q) => [
      lastSegment(q.id, path),
      await walk(qu, q.value, opts, seen, depth - 1),
    ]));
    if (opts.asArray) {
      return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
    }
    return Object.fromEntries(entries);
  }

  // scheme === 'file'
  if (opts.fileHandler) return opts.fileHandler.resolveFileRef(qu, ref);
  const qubit = await qu.get(path);
  return qubit?.value;
}

/**
 * Walks a plain value (string/array/object), resolving any obj://|key://|file://
 * strings found inside it, up to `depth` cascades past the top level. Leaves
 * out-of-budget or cyclic refs as the raw, unresolved string.
 *
 * `seen` is this branch's ancestor chain, not a tree-wide dedup set: forking
 * a fresh copy per reference (instead of mutating one shared Set) means the
 * *same* ref appearing twice in unrelated positions (two rows pointing at
 * the same file, say) resolves independently both times — only an actual
 * cycle (a ref reachable from itself along one path) gets short-circuited.
 */
async function walk(qu, value, opts, seen, depth) {
  if (isReference(value)) {
    if (depth <= 0 || seen.has(value)) return value;
    const nextSeen = new Set(seen);
    nextSeen.add(value);
    return resolveOne(qu, value, opts, nextSeen, depth);
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((v) => walk(qu, v, opts, seen, depth)));
  }
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await walk(qu, v, opts, seen, depth)]));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Resolves a single reference string. `maxDepth` (default 1) bounds how far
 * to cascade into further references found inside the resolved value/rows —
 * the reference passed in is always resolved regardless. `asArray: true`
 * (obj:// only) returns a segment-sorted array instead of a keyed object.
 * `fileHandler` (optional) is what makes `file://` refs resolve to actual
 * bytes instead of a raw manifest — see createFileHandlerPlugin().
 */
export async function resolveReference(qu, ref, { maxDepth = 1, asArray = false, fileHandler } = {}) {
  return resolveOne(qu, ref, { asArray, fileHandler }, new Set([ref]), maxDepth);
}

/** Same resolution, but walks an arbitrary value (e.g. a whole QuBit's `.value`) looking for reference strings anywhere inside it, instead of requiring the top-level value itself to be one. */
export async function resolveValue(qu, value, { maxDepth = 1, asArray = false, fileHandler } = {}) {
  return walk(qu, value, { asArray, fileHandler }, new Set(), maxDepth);
}

/**
 * Follows a chain of `key://` redirects starting AT `id` itself (not at a
 * value inside it) — the mechanism behind `QuSpace`'s transparent
 * get()/put()/set()/on()/map() reference-following (see space-handle.js's
 * `resolveDispatch`, wired up by createReferenceHandlerPlugin() below).
 *
 * Deliberately narrower than resolveReference()/resolveValue(): only
 * `key://` is followed (a single value AT another id — the "keep
 * navigating" case). `obj://` (a collection) and `file://` (bytes) are
 * left as-is even if encountered — their resolved SHAPE isn't "a value at
 * an id" (an object/array, or raw bytes), so folding them into this
 * id-to-id chain would make `await node`'s return type unpredictable
 * (sometimes a QuBit, sometimes an array, sometimes bytes) purely based on
 * what happens to be stored — resolve those explicitly via
 * resolveReference()/resolveFileRef() instead.
 *
 * Returns `{ id, qubit }` — the final, non-redirecting id and whatever is
 * actually stored there (`null` if nothing is). `id` reflects wherever
 * resolution actually landed, not the id passed in — the way a caller
 * keeps navigating into the referenced target without a separate verb:
 * `qu.get((await node).id)`.
 *
 * `maxHops` (default 8) bounds chained redirects (an alias pointing at an
 * alias pointing at...) — throws a clear, actionable error on a cycle
 * (revisiting an id already seen this chain) or on exceeding the budget,
 * rather than hanging.
 */
export async function resolveKeyChain(session, id, { maxHops = 8 } = {}) {
  let current = String(id);
  const seen = new Set();
  // `<= maxHops`, not `<`: maxHops counts REDIRECTS followed, and resolving
  // the final, non-redirecting target always costs one more read than the
  // redirects themselves (you have to read it to find out it ISN'T one) —
  // `maxHops = 3` must be able to actually reach a target 3 hops away, not
  // fail one read short of it.
  for (let hops = 0; hops <= maxHops; hops++) {
    if (seen.has(current)) {
      throw new Error(`[References] key://-Zyklus erkannt beim Auflösen von "${id}" (erneut "${current}" erreicht) — eine Referenz zeigt direkt oder über mehrere Sprünge auf sich selbst.`);
    }
    seen.add(current);
    const qubit = await session.get(current);
    if (!qubit || !isReference(qubit.value)) return { id: current, qubit };
    const { scheme, path } = parseReference(qubit.value);
    if (scheme !== 'key') return { id: current, qubit }; // obj://, file:// — bewusst nicht automatisch weiterverfolgt, siehe Doc-Kommentar oben
    current = path;
  }
  throw new Error(`[References] zu viele verkettete key://-Weiterleitungen beim Auflösen von "${id}" (maxHops=${maxHops}) — möglicher Zyklus oder maxHops zu niedrig für diese Anwendung.`);
}

/**
 * `qu.use(createReferenceHandlerPlugin(...))` — attaches `qu.resolveReference()`/
 * `qu.resolveValue()` sugar bound to this Qu instance, with the given
 * defaults (still overridable per call), AND installs the `resolveKeyChain()`-
 * based resolver every `QuSpace` node's get()/put()/set()/on()/map() uses by
 * default (`qu.setResolveHandler()` — see space-handle.js). Without this
 * plugin, `resolveDispatch` defaults to the identity function (no `key://`
 * following at all) — Core itself never imports this file or knows `key://`
 * means anything. `maxHops` bounds the resolver's chained-redirect budget
 * (see resolveKeyChain()).
 */
export function createReferenceHandlerPlugin({ maxDepth = 1, asArray = false, fileHandler, maxHops = 8 } = {}) {
  const defaults = { maxDepth, asArray, fileHandler };
  return {
    install(qu) {
      qu.resolveReference = (ref, opts) => resolveReference(qu, ref, { ...defaults, ...opts });
      qu.resolveValue = (value, opts) => resolveValue(qu, value, { ...defaults, ...opts });
      qu.setResolveHandler(async (session, id) => (await resolveKeyChain(session, id, { maxHops })).id);
    },
  };
}
