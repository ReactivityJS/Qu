// Mimics just enough of node:test's `test(name, fn)` for our *.test.mjs
// files to run unmodified in a browser via an import map. No QU-specific
// logic — this is generic test-harness plumbing only.
const queue = [];

export function test(name, fn) {
  queue.push({ name, fn });
}

/** Runs and clears whatever is CURRENTLY queued (not tests queued later by
 * a subsequent import) — the building block both `runAll()` and a
 * per-file dashboard (import one file, drain, import the next) need,
 * since `test()` calls happen synchronously as each file's top-level code
 * runs, so "queue length right after one `await import()`" is exactly
 * that file's tests. */
export async function drain(onResult) {
  const items = queue.splice(0, queue.length);
  const results = [];
  for (const { name, fn } of items) {
    const start = performance.now();
    try {
      await fn();
      results.push({ name, pass: true, ms: performance.now() - start });
    } catch (error) {
      results.push({ name, pass: false, ms: performance.now() - start, error });
    }
    onResult?.(results[results.length - 1]);
  }
  return results;
}

export async function runAll(onResult) {
  return drain(onResult);
}
