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
//
// Route shape is SPACE-FIRST, uniformly: the first segment is always a
// Space id — either `~<fp>` (a User-Space, always structurally valid, no
// manifest needed — the identity IS the space) or a generic Space UUID
// (an ordinary `qu.createSpace()`'d space, e.g. a forum board). There is
// no structural difference between the two in this router: "did the user
// start at their own identity" was never the rule, only that `~<fp>`
// happens to already BE a valid space id on its own. A second, optional
// segment says which app renders that space; if omitted, the caller
// decides a default (this router doesn't reach into Space manifests —
// see `decideRoute()`'s own doc comment on `space-default` below).
//
// One backward-compatible exception: a first segment that matches a known
// FIXED-mode app (`spaceMode` absent or `'fixed'` — chat/hunt/calendar-style
// singleton apps whose own manifest already carries a `fixedSpaceId`) is
// still treated as a bare app id, exactly like before this convergence —
// existing bookmarks (`#/chat`, `#/hunt`) keep working unchanged.

/**
 * Pure routing decision for one hash value — no I/O, no `window`. `services`
 * is the (optional) currently-known catalog (server/service-registry.mjs's
 * `toJSON()` shape: `{id, category, label, entry?, enabled?, spaceMode?, ...}[]`).
 *
 * Checked in order:
 *   - empty segments                             -> `{kind:'home'}`
 *   - first segment matches a FIXED app (legacy)  -> `{kind:'app', appId, entry}`
 *   - first segment is `~<fp>` or `u/<fp>`        -> space-first (`~<fp>` form)
 *   - anything else                               -> space-first (a generic Space-UUID)
 *
 * The fingerprint itself is NOT validated for the `~fp` form (no
 * isValidFingerprint() check) — malformed input is the identity screen's
 * problem to render an error for, this function only ever decides WHICH
 * screen, never whether its argument is well-formed. A Space UUID is
 * likewise never validated (no way to, without an async read this
 * function deliberately never does — see `space-default` below).
 *
 * For BOTH space-first forms, the (optional) second segment is the appId
 * that renders this space:
 *   - given, matches an enabled+`entry`-having catalog service
 *     -> `{kind:'space', spaceId, appId, entry, segments}`
 *   - given, but no such match (unknown/disabled/no entry)
 *     -> `{kind:'unknown', spaceId, appId, segments}`
 *   - NOT given at all
 *     -> `{kind:'space-default', spaceId, segments}` — deciding a default
 *     renderer (the built-in identity screen for a `~fp` space; a Space's
 *     own optional `appId` manifest field for a generic one, see
 *     APP-GUIDE.md's App-Space pattern) needs an async Space read this
 *     PURE function never performs — that's the caller's (the shell's) job.
 *
 * For the legacy bare-fixed-app form, the catalog dependency mirrors the
 * space-first case: `services === undefined` (not yet fetched at all)
 * -> `{kind:'pending', segments}`, distinct from a loaded-but-non-matching
 * catalog (`{kind:'unknown', appId, segments}`, no `spaceId` — there never
 * was one in this form) — same "don't flash unknown while still loading"
 * reasoning as before this convergence.
 */
export function decideRoute(hash, { services } = {}) {
  const segments = parsePathSegments(hash);
  if (segments.length === 0) return { kind: 'home', segments };

  const first = segments[0];

  // Legacy bare-fixed-app form — checked FIRST, before ~fp/space handling,
  // since it's a completely different grammar (one segment IS the app,
  // no separate space segment at all) that must keep matching exactly the
  // same inputs it always has.
  if (!first.startsWith('~') && first !== 'u') {
    if (services === undefined) return { kind: 'pending', segments };
    const fixedMatch = services.find((s) => s.id === first && (s.spaceMode === undefined || s.spaceMode === 'fixed'));
    if (fixedMatch && fixedMatch.enabled !== false && fixedMatch.entry) {
      return { kind: 'app', appId: first, entry: fixedMatch.entry, segments };
    }
  }

  // Space-first: resolve `spaceId` + the remaining segments (appId first).
  let spaceId;
  let rest;
  if (first.startsWith('~')) {
    spaceId = first;
    rest = segments.slice(1);
  } else if (first === 'u' && segments.length >= 2) {
    spaceId = `~${segments[1]}`;
    rest = segments.slice(2);
  } else {
    // Not `~fp`/`u/fp`, and not a known fixed app (checked above) — treat
    // as a generic Space UUID.
    spaceId = first;
    rest = segments.slice(1);
  }

  const appId = rest[0];
  if (appId === undefined) return { kind: 'space-default', spaceId, segments };
  if (services === undefined) return { kind: 'pending', segments };

  const match = services.find((s) => s.id === appId);
  if (match && match.enabled !== false && match.entry) {
    return { kind: 'space', spaceId, appId, entry: match.entry, segments };
  }
  return { kind: 'unknown', spaceId, appId, segments };
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
 * resolves a `pending` decision into `app`/`space`/`unknown` the moment
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
