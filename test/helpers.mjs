import { QuRuntime, QuStore, MemoryAdapter, createVerifyPlugin } from '../src/index.js';

export function makeRuntime() {
  const rt = new QuRuntime({ store: new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]) });
  rt.use(createVerifyPlugin());
  return rt;
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let o = 0; o < n; o += 65536) crypto.getRandomValues(out.subarray(o, Math.min(o + 65536, n)));
  return out;
}

/**
 * A handful of tests deliberately trigger an error path (a forged qubit, a
 * throwing subscriber) specifically to prove it's handled gracefully — the
 * resulting console.error is the test passing, not failing. Without this,
 * that expected noise is indistinguishable from a real problem when
 * watching the console (CLI or browser) during a normal run. Captures the
 * calls (so the test can still assert on them) without ever printing them.
 */
export async function withSilencedConsoleError(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => { calls.push(args); };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}
