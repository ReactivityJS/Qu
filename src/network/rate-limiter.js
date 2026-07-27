// Protects a Relay from a single fingerprint flooding it with writes (see
// DefaultReplication's `rateLimiter` option). A sliding-window counter per
// key, not a token bucket — good enough for "stop one peer from drowning
// out everyone else," no burst-smoothing sophistication this scope needs.
// Bounded the same way DefaultReplication's own `#recentlyFromPeer` cache
// already is (evict the single oldest entry once over a generous cap) — a
// long-running relay must not leak one Map entry per fingerprint ever seen.
export function createRateLimiter({ maxPerWindow = 100, windowMs = 1000, maxTrackedKeys = 1000 } = {}) {
  const hits = new Map(); // key -> timestamps[] within the current window

  return {
    /** true = allowed, false = this key is currently over its limit. */
    allow(key) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const timestamps = (hits.get(key) ?? []).filter((t) => t >= cutoff);
      const allowed = timestamps.length < maxPerWindow;
      if (allowed) timestamps.push(now);
      hits.set(key, timestamps);
      if (hits.size > maxTrackedKeys) hits.delete(hits.keys().next().value);
      return allowed;
    },
    /**
     * Live-reconfigure the window/threshold (e.g. from an admin command,
     * see relay/relay.mjs's `admin/config/rate-limit`) — existing tracked
     * hits are left as-is (they age out of the window normally under the
     * new `windowMs`), only the two thresholds change, no reset/flush.
     */
    configure({ maxPerWindow: newMax, windowMs: newWindowMs } = {}) {
      if (newMax !== undefined) maxPerWindow = newMax;
      if (newWindowMs !== undefined) windowMs = newWindowMs;
    },
    getConfig() {
      return { maxPerWindow, windowMs };
    },
  };
}
