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
    const rows = await qu.query(`${path}/*`);
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

/** `qu.use(createReferenceHandlerPlugin(...))` — attaches `qu.resolveReference()`/`qu.resolveValue()` sugar bound to this Qu instance, with the given defaults (still overridable per call). */
export function createReferenceHandlerPlugin({ maxDepth = 1, asArray = false, fileHandler } = {}) {
  const defaults = { maxDepth, asArray, fileHandler };
  return {
    install(qu) {
      qu.resolveReference = (ref, opts) => resolveReference(qu, ref, { ...defaults, ...opts });
      qu.resolveValue = (value, opts) => resolveValue(qu, value, { ...defaults, ...opts });
    },
  };
}
