import { parsePathSegments } from './hash-router.js';

// The dispatch layer QUniverse's shell needs — built strictly on top of
// hash-router.js's existing buildPath()/parsePathSegments() (reused
// verbatim, not reimplemented). Node-safe (no `window` access anywhere in
// this file) — the injection seam (`getHash`/`onHashChange` as parameters,
// see createRouter() below) is what a FUTURE in-shell-embedded app would
// need to not own `window.location.hash` outright, but that scoping/
// translation mechanism itself is deliberately NOT built here yet — no
// caller exists for it in this phase (every app is still an `entry`-
// redirect), and building it now would be speculative generality with
// nothing to verify it against.

/**
 * Pure routing decision for one hash value — no I/O, no `window`. `services`
 * is the (optional) currently-known catalog (server/service-registry.mjs's
 * `toJSON()` shape: `{id, category, label, entry?, enabled?, ...}[]`).
 *
 * Three top-level shapes, checked in order:
 *   - empty segments                          -> `{kind:'home'}`
 *   - `~<fp>` as the first segment             -> `{kind:'identity', fingerprint}`
 *   - `u/<fp>` (two segments)                  -> `{kind:'identity', fingerprint}`
 *     (a friendlier alias for the same target — <qu-profile-card>'s own
 *     `qu-profile-open` event navigates via the `~<fp>` form, `u/<fp>` is
 *     for a hand-typed/shared link)
 *   - anything else                            -> looked up against `services`
 *
 * The fingerprint itself is NOT validated here (no isValidFingerprint()
 * check) — malformed input is the identity screen's problem to render an
 * error for, this function only ever decides WHICH screen, never whether
 * its argument is well-formed.
 *
 * For the app-lookup case, THREE outcomes depending on `services`:
 *   - `services` is `undefined` (not supplied at all, e.g. not yet fetched)
 *     -> `{kind:'pending', appId}` — distinct from an empty-but-loaded
 *     catalog, so a bookmarked/shared app link doesn't flash "unknown"
 *     while `/relay/services` is still in flight.
 *   - `services` is an array but no entry matches `appId`, OR the match
 *     has no usable `entry` (disabled, or `mount`-only with no `entry`
 *     fallback — this phase has no in-shell mounting to act on either way)
 *     -> `{kind:'unknown', appId}`
 *   - a match with `enabled !== false` and a set `entry`
 *     -> `{kind:'app', appId, entry}`
 */
export function decideRoute(hash, { services } = {}) {
  const segments = parsePathSegments(hash);

  if (segments.length === 0) return { kind: 'home', segments };

  const first = segments[0];
  if (first.startsWith('~')) {
    return { kind: 'identity', fingerprint: first.slice(1), segments };
  }
  if (first === 'u' && segments.length >= 2) {
    return { kind: 'identity', fingerprint: segments[1], segments };
  }

  const appId = first;
  if (services === undefined) return { kind: 'pending', appId, segments };

  const match = services.find((s) => s.id === appId);
  if (match && match.enabled !== false && match.entry) {
    return { kind: 'app', appId, entry: match.entry, segments };
  }
  return { kind: 'unknown', appId, segments };
}

/**
 * Wires decideRoute() up to a live hash source — `getHash()`/`onHashChange(cb)`
 * are injected (see ui/router-browser.js's createWindowHashSource() for the
 * real-window default) rather than this file touching `window` itself, so
 * the dispatch behavior stays testable without a DOM.
 *
 * `.start()` calls the registered handler once, SYNCHRONOUSLY, with the
 * current hash's decision, then subscribes to further changes — the same
 * "call once immediately, then listen" contract examples/space-app-browser.js's
 * `watchRoute()` already uses. Returns an unsubscribe function.
 *
 * `.setServices(list)` updates the known catalog AND immediately re-emits
 * the CURRENT hash's decision (no hash change needed) — this is what
 * resolves a `pending` decision into `app`/`unknown` the moment
 * `/relay/services` actually resolves.
 */
export function createRouter({ getHash, onHashChange, services } = {}) {
  let currentServices = services;
  let handler = null;

  function emit() {
    if (handler) handler(decideRoute(getHash(), { services: currentServices }));
  }

  return {
    onRoute(fn) { handler = fn; },
    setServices(list) { currentServices = list; emit(); },
    start() {
      emit();
      const unsubscribe = onHashChange(emit);
      return () => unsubscribe?.();
    },
  };
}
