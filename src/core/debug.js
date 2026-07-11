// Debug output as an opt-in listener, not console.log calls sprinkled
// through the code. Two reasons this beats a dev/prod-stripped-build
// approach for QU specifically:
//   1. QU has no build/minification step by design (§2 Designziele) — a
//      "strip debug calls in prod" scheme would require introducing one
//      just for this, which is a bigger architectural change than the
//      problem calls for.
//   2. A listener can be structured (scope, event, data) instead of raw
//      text — useful for a debug PANEL in the browser demo, not just a
//      console, and filterable by scope without editing source.
//
// Cost when nobody's listening: one Set.size check per call site. No
// listeners registered = the debug() calls throughout Core/Replication/
// Files/Relay do effectively nothing.
const listeners = new Set();

export function onDebug(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function debug(scope, event, data) {
  if (listeners.size === 0) return;
  const entry = { scope, event, data, ts: Date.now() };
  for (const fn of listeners) {
    try { fn(entry); } catch { /* a broken listener must not break the thing it's observing */ }
  }
}

/**
 * Convenience default listener: formats entries to console.log/console.error.
 * Works identically in Node (the relay) and the browser (the demo) — same
 * function, same output shape, per the "same flow as in the browser"
 * principle. `filter` narrows to specific scopes (e.g. ['relay', 'files']).
 */
export function enableConsoleDebug({ filter = null } = {}) {
  return onDebug((entry) => {
    if (filter && !filter.includes(entry.scope)) return;
    const label = `[${entry.scope}:${entry.event}]`;
    if (entry.data instanceof Error || entry.event.includes('error') || entry.event.includes('reject')) {
      console.error(label, entry.data);
    } else {
      console.log(label, entry.data ?? '');
    }
  });
}
