// Shared by Runtime.on() and Session.on() — the "fetch what already exists,
// then only new changes" pattern was, until now, something every caller
// had to hand-roll themselves (query() the existing rows, loop over them,
// THEN register on()) — easy to get subtly wrong (a qubit arriving in the
// gap between the query and the subscribe either gets delivered twice or
// missed entirely). This is that pattern, done once, correctly.
//
// `initial: true`  — deliver everything currently matching `pattern`
//                     first, then keep delivering only new/changed qubits.
// `once: true`      — deliver everything currently matching `pattern`,
//                     then stop; no ongoing subscription at all. Implies
//                     `initial` (there'd be nothing to deliver otherwise).
// neither set        — exactly the pre-existing behaviour: forward-only,
//                     nothing already in the store is delivered. This is
//                     the default specifically so every existing caller
//                     keeps working unchanged.
//
// on() itself must stay synchronous (existing callers do
// `const off = qu.on(...); ... off();` without awaiting) — so this always
// returns an unsubscribe function immediately, even for `initial`/`once`,
// where the actual catch-up query runs in the background. A `cancelled`
// guard makes calling that returned function before the catch-up finishes
// behave correctly (no delivery, no dangling subscription left behind).
export function subscribeWithOptions({ queryFn, subscribeFn, pattern, callback, initial = false, once = false }) {
  if (!initial && !once) {
    return subscribeFn(pattern, callback);
  }

  let unsubscribeInner = null;
  let cancelled = false;

  (async () => {
    const existing = await queryFn(pattern);
    existing.sort((a, b) => a.ts - b.ts);
    // Captures exactly which (id, ts) versions were already delivered via
    // the snapshot, so a qubit that arrives in the gap between the query
    // above and the subscription below is never delivered twice — and a
    // qubit that arrives genuinely after the snapshot (even one that
    // reuses an id, e.g. an LWW update) is never silently dropped just
    // because that id was already seen once. A ts-only or id-only key
    // would get either of those cases wrong.
    const seen = new Set(existing.map((q) => `${q.id}|${q.ts}`));
    for (const q of existing) {
      if (cancelled) return;
      callback(q);
    }
    if (once || cancelled) return;
    unsubscribeInner = subscribeFn(pattern, (q) => {
      if (seen.has(`${q.id}|${q.ts}`)) return;
      callback(q);
    });
  })();

  return () => {
    cancelled = true;
    if (unsubscribeInner) unsubscribeInner();
  };
}
