import { onDebug, debug } from '../../src/core/debug.js';

// Reference implementation of the custom-service extension contract
// (server/service-registry.mjs's file doc — read that first for the
// "why code-level, not remote/dynamic" reasoning this file is a concrete
// instance of). Bans a fingerprint (falling back to the raw peerFingerprint/
// channelId when a push had no claimed writer at all — same fallback
// order network/ingest-gate.js's rateLimitGate() already uses, for the
// same reason) after too many of its pushes are REJECTED by this relay's
// own ingest() within a window — a real "N strikes" abuse mitigation, not
// a rate limiter (createRateLimiter()/rateLimitGate() already cover
// "too much legitimate traffic too fast"; this one is specifically about
// REPEATED REJECTIONS — bad signatures, ACL denials, malformed payloads —
// the kind of traffic only a misbehaving or attacking client produces).
//
// How it learns about a rejection WITHOUT this relay needing a bespoke
// "on ingest failure" hook: network/replication/default.js's existing
// `debug('replication', 'push-rejected', { id, writer, error })` call
// (core/debug.js's debug bus, the same mechanism enableConsoleDebug()
// already taps into) already fires for exactly this. attachDebugBus()
// below just subscribes to it — zero changes needed to the replication
// path itself beyond that debug payload already carrying `writer`.
export function createFail2banService({
  maxFailuresPerWindow = 5,
  windowMs = 60_000,
  banDurationMs = 15 * 60_000,
} = {}) {
  const failures = new Map(); // key -> timestamps[] within the current window
  const bans = new Map(); // key -> unbanAt (epoch ms)
  let offDebug = null;

  /** Bounded the same way network/rate-limiter.js already is — a long-running relay must not leak one Map entry per fingerprint ever seen. */
  function evictOldest(map, maxTrackedKeys = 1000) {
    if (map.size > maxTrackedKeys) map.delete(map.keys().next().value);
  }

  function isBanned(key) {
    const until = bans.get(key);
    if (until === undefined) return false;
    if (Date.now() >= until) { bans.delete(key); return false; } // ban expired — evaluated lazily, no timer needed for this part
    return true;
  }

  /** Records one rejected push attributed to `key` — bans it once `maxFailuresPerWindow` is reached within `windowMs`. */
  function recordFailure(key) {
    if (!key) return;
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = (failures.get(key) ?? []).filter((t) => t >= cutoff);
    timestamps.push(now);
    if (timestamps.length >= maxFailuresPerWindow) {
      bans.set(key, now + banDurationMs);
      evictOldest(bans);
      failures.delete(key);
      debug('fail2ban', 'banned', { key, banDurationMs, failureCount: timestamps.length });
    } else {
      failures.set(key, timestamps);
      evictOldest(failures);
    }
  }

  function unban(key) {
    const was = bans.delete(key);
    failures.delete(key);
    debug('fail2ban', 'unbanned', { key, wasBanned: was });
    return was;
  }

  return {
    id: 'fail2ban',
    category: 'custom',
    label: 'Fail2ban',
    description: `Bannt einen Fingerprint für ${Math.round(banDurationMs / 60_000)} Minuten nach ${maxFailuresPerWindow} abgelehnten Pushes innerhalb von ${Math.round(windowMs / 1000)}s.`,

    // Rejects EARLY (before verify/ACL even run) for an already-banned
    // key — same `(ctx, next) => Promise<void>` shape as every other
    // ingest gate (network/ingest-gate.js), so relay.mjs's registry.
    // ingestGates() wiring needs no special case for this one.
    ingestGates: [async (ctx, next) => {
      const key = ctx.qubit?.writer ?? ctx.peerFingerprint ?? ctx.channelId;
      if (isBanned(key)) throw new Error(`[Fail2ban] push rejected: "${key}" is temporarily banned`);
      return next();
    }],

    /** Subscribes to the debug bus for real ingest rejections — see file doc above. Idempotent (re-attaching replaces the previous subscription instead of stacking a second one), called once by relay.mjs at relay construction. */
    attachDebugBus() {
      offDebug?.();
      offDebug = onDebug((entry) => {
        if (entry.scope !== 'replication' || entry.event !== 'push-rejected') return;
        recordFailure(entry.data?.writer);
      });
      return () => { offDebug?.(); offDebug = null; };
    },

    /**
     * `admin/service/fail2ban/unban` (relay/relay.mjs's admin-event
     * dispatch) — decrypted payload `{ key }` lifts a ban immediately,
     * without waiting for it to expire on its own. This is CONFIGURATION
     * of an already-installed service, not new logic — exactly the
     * boundary the extension contract documents as remotely
     * administrable.
     */
    onAdminEvent(action, payload) {
      if (action === 'unban' && payload?.key) return unban(payload.key);
      return false;
    },

    // Test-only introspection — not part of the extension contract
    // itself (a real custom service doesn't need to expose this), just
    // lets test/fail2ban-service.test.mjs assert on ban state directly
    // instead of only through side effects on a real ingest pipeline.
    isBanned,
    recordFailure,
  };
}
