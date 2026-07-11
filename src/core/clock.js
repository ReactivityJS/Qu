// Hybrid-logical-ish clock: wall time + fractional sequence counter.
// NOTE (honest caveat, see README): this gives a *total order* for LWW
// conflict resolution, not causal/vector-clock consistency. Two writers
// with skewed system clocks can still "win" unfairly. That's an accepted
// trade-off (same one GunDB's HAM makes), not a bug — but it must be
// documented, not implied away as "deterministic" without qualification.
export class QuClock {
  #wall = Date.now();
  #seq = 0;

  next() {
    const now = Date.now();
    if (now > this.#wall) {
      this.#wall = now;
      this.#seq = 0;
    } else {
      this.#seq = Math.min(this.#seq + 1, 9999);
    }
    return this.#wall + this.#seq / 10000;
  }

  receive(remoteTs) {
    const w = Math.floor(remoteTs);
    if (w > this.#wall) {
      this.#wall = w;
      this.#seq = 0;
    }
  }
}
