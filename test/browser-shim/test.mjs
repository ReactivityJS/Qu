// Mimics just enough of node:test's `test(name, fn)` for our *.test.mjs
// files to run unmodified in a browser via an import map. No QU-specific
// logic — this is generic test-harness plumbing only.
const queue = [];

export function test(name, fn) {
  queue.push({ name, fn });
}

export async function runAll(onResult) {
  const results = [];
  for (const { name, fn } of queue) {
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
