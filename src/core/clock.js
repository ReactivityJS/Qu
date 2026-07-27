// Hybrid-logical-ish clock: wall time + fractional sequence counter.
// NOTE (honest caveat, see README): this gives a *total order* for LWW
// conflict resolution, not causal/vector-clock consistency. Two writers
// with skewed system clocks can still "win" unfairly. That's an accepted
// trade-off (same one GunDB's HAM makes), not a bug — but it must be
// documented, not implied away as "deterministic" without qualification.
//
// The fractional part's divisor is 1000, not 10000: `Date.now()` is
// already a ~13-digit number, and IEEE-754 doubles only carry ~15-17
// significant decimal digits — adding a /10000 fraction (needing 4 more
// digits) silently rounds away for many sequence values at today's
// wall-clock magnitude (verified: `1783889041243 + 0.0001 === 1783889041243`
// evaluates to `true`), producing genuine ts *collisions* between two
// different same-millisecond writes on the same clock instance. Since
// QuStore.put() treats an equal ts as an idempotent no-op (correct for a
// true duplicate delivery, wrong here), the second write was silently
// discarded instead of applied — a real, previously-unnoticed data-loss
// bug, not a hypothetical one (reproduced via examples/todo-lib.mjs's
// grantWriteAccess() racing createSpace()'s manifest write). /1000 (three
// fractional digits, seq capped at 999 instead of 9999) stays within safe
// double precision at least through the year 2100 — see
// test/clock.test.mjs, which asserts this directly instead of trusting the
// math by inspection.
export class QuClock {
  #wall = Date.now();
  #seq = 0;

  next() {
    const now = Date.now();
    if (now > this.#wall) {
      this.#wall = now;
      this.#seq = 0;
    } else {
      this.#seq = Math.min(this.#seq + 1, 999);
    }
    return this.#wall + this.#seq / 1000;
  }

  // Only #wall is merged from a remote timestamp — #seq deliberately resets
  // to 0 rather than adopting/max-ing the remote fractional part. #seq's
  // only job is to keep THIS instance's own next() calls within the same
  // millisecond monotonically increasing relative to each other; it has no
  // meaning borrowed from a remote clock (whose own #seq counts ITS local
  // same-millisecond writes, not ours). Taking max(local, remote) here
  // would just make this instance's next ts artificially close to the
  // remote's, without making same-millisecond ordering between the two
  // writers any more correct than the wall-time-plus-writer-fingerprint tie
  // break (see compareQubits()) already does.
  receive(remoteTs) {
    const w = Math.floor(remoteTs);
    if (w > this.#wall) {
      this.#wall = w;
      this.#seq = 0;
    }
  }
}
