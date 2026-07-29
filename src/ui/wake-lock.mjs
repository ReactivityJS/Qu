// One shared Screen Wake Lock helper — generalizes the pattern that grew
// independently, and slightly differently, in two places: examples/hunt's
// `setupWakeLock(toggle)` (a user-facing on/off checkbox) and
// examples/chat's `beginTransfer()`/`endTransfer()` (a reference-counted
// lock held for the duration of file attachment transfers — chat's own
// "upload/download sync" case). Both need the exact same low-level
// mechanics (request the lock, re-request it after the browser
// auto-releases it on tab-hide, tolerate a browser without the API at
// all) and neither needed its own opinion on WHEN to hold the lock — that
// decision (a checkbox vs. a transfer counter) stays with the caller.
// Browser-only (touches `navigator`/`document`), same charter as this
// directory's other browser-only files (see push.mjs).

/** Whether this browser supports the Screen Wake Lock API at all — feature-detect once, e.g. to decide whether to even render a keep-awake toggle. */
export function isWakeLockSupported() {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/**
 * Creates one independent wake-lock handle. `acquire()`/`release()` set the
 * caller's DESIRED state (`held`); the actual OS-level lock is best-effort
 * underneath it, since a browser silently releases the real lock whenever
 * the tab goes to the background (spec behavior, not a bug) — this handle
 * re-requests it automatically once the tab becomes visible again, as long
 * as `held` is still true, so a caller never has to wire its own
 * `visibilitychange` listener. Missing API support, a denied permission, or
 * a battery-saver rejection all degrade to a silent no-op (`acquire()`
 * never throws) — same "stay inert, not broken" stance as this directory's
 * other browser-feature wrappers (see push.mjs's own doc comment).
 *
 * Multiple independent callers on the same page each get their own handle
 * (and thus their own OS-level `WakeLockSentinel`) — deliberate, so one
 * caller's `release()` (e.g. a toggle switching off) can never cut short a
 * DIFFERENT caller's still-active hold (e.g. an in-flight file transfer);
 * a caller that wants "hold while N things are happening" layers its own
 * refcount on top of ONE handle's `acquire()`/`release()`, exactly as
 * examples/chat/app.mjs's `beginTransfer()`/`endTransfer()` do.
 */
export function createWakeLock() {
  let sentinel = null;
  let held = false;

  async function requestSentinel() {
    if (sentinel || !held || !isWakeLockSupported() || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      // e.g. battery saver, permission denied — stays inert, next visibilitychange retries
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestSentinel();
  });

  return {
    /** Marks the lock as wanted and best-effort requests it right away. */
    async acquire() {
      held = true;
      await requestSentinel();
    },
    /** Marks the lock as no longer wanted and releases the underlying sentinel, if any. */
    release() {
      held = false;
      sentinel?.release().catch(() => {});
      sentinel = null;
    },
    /** The caller's own last-set desired state (not whether a real OS-level sentinel is currently held — that's an implementation detail, see file doc). */
    isHeld: () => held,
  };
}
