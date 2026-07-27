// Caps WHO/HOW MANY may hold an open connection to a Relay — a coarser,
// earlier check than ingest-gate.js's per-PUSH gates: those run per incoming
// write, once a connection already exists; this runs once, right after a
// Channel authenticates (relay/relay.mjs's attachChannel()), before the
// connection is treated as live (added to `connected`, wired for file
// mirroring/routed signaling/etc.). Same "reusable building block, not a
// hard-coded constructor flag" shape as createRateLimiter() — a plain
// object with a live-mutable config, so an admin command
// (`admin/config/connection-limit`, see relay.mjs) can change it without
// tearing down the Relay.
//
// Two independent, optional limits, both `null` (off) by default:
//   maxConnections        — a hard ceiling on simultaneously connected,
//                            AUTHENTICATED (non-null peerFingerprint)
//                            connections. An anonymous/unauthenticated
//                            connection (peerFingerprint === null, e.g. a
//                            read-only visitor) is never counted or capped
//                            by this — it has no fingerprint to enforce a
//                            per-identity limit against in the first place.
//   allowedFingerprints   — an allowlist: if set, ONLY these fingerprints
//                            may hold an authenticated connection at all
//                            (an anonymous connection is unaffected by this
//                            either, same reasoning). `null` = anyone.
export function createConnectionGate({ maxConnections = null, allowedFingerprints = null } = {}) {
  return {
    /**
     * `fingerprint` — the connection's own proven fingerprint, or `null`
     * for an anonymous connection (never rejected by this gate).
     * `connectedCount` — how many AUTHENTICATED connections are already
     * live, BEFORE this one — the caller's own bookkeeping (relay.mjs's
     * `connected` Map), not tracked here, so this stays a pure decision
     * function with no connection state of its own.
     * Returns `{ allowed, reason? }`.
     */
    check({ fingerprint, connectedCount }) {
      if (!fingerprint) return { allowed: true };
      if (allowedFingerprints && !allowedFingerprints.includes(fingerprint)) {
        return { allowed: false, reason: 'not-allow-listed' };
      }
      if (maxConnections != null && connectedCount >= maxConnections) {
        return { allowed: false, reason: 'max-connections' };
      }
      return { allowed: true };
    },
    /** Live-reconfigure (e.g. from an admin command) — `undefined` fields are left unchanged, explicit `null` clears a limit. */
    configure({ maxConnections: newMax, allowedFingerprints: newList } = {}) {
      if (newMax !== undefined) maxConnections = newMax;
      if (newList !== undefined) allowedFingerprints = newList;
    },
    getConfig() {
      return { maxConnections, allowedFingerprints };
    },
  };
}
