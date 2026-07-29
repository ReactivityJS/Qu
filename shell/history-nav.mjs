// Pure, DOM-free "recent pages" logic for qu-history-nav.mjs — same split
// as nav-catalog.mjs sits next to qu-nav-dropdown.mjs (browser-only Custom
// Elements can't be imported in Node, so anything worth a real `node --test`
// has to live here instead).
//
// Deliberately does NOT reimplement Back/Forward — `location.hash = ...` is
// ALREADY a normal history entry everywhere in this shell (no
// `history.replaceState()` anywhere, verified), so the browser's own
// `history.back()`/`history.forward()` already walk it correctly; this
// module only covers what the browser genuinely has no API for: listing
// recently visited pages for a quick-jump dropdown.

import { buildPath } from '../src/index.js';

const MAX_ENTRIES = 15;

/**
 * Turns one `decideRoute()` decision (src/ui/router.js) into a jump-list
 * entry — `null` for `'pending'` (catalog not loaded yet, not a real page
 * to remember) so the caller never records a placeholder. `services` is
 * the current catalog (for an app's label/icon) — an entry that names an
 * appId no longer in the catalog still gets a plain fallback label, never
 * throws.
 */
export function describeDecision(decision, services = []) {
  const hash = buildPath(...decision.segments);
  switch (decision.kind) {
    case 'home':
      return { hash, kind: 'home', label: 'Start', icon: '🏠' };
    case 'space-default':
      if (decision.spaceId.startsWith('~')) {
        return { hash, kind: 'identity', label: null, fingerprint: decision.spaceId.slice(1), icon: '👤' };
      }
      return { hash, kind: 'space', label: decision.spaceId, icon: '📦' };
    case 'app':
    case 'space': {
      const svc = services.find((s) => s.id === decision.appId);
      return { hash, kind: 'app', label: svc?.label ?? decision.appId, icon: svc?.icon ?? '📦' };
    }
    case 'unknown':
      return { hash, kind: 'unknown', label: `Unbekannt: ${decision.appId ?? decision.spaceId}`, icon: '❓' };
    default: // 'pending'
      return null;
  }
}

/**
 * Appends `entry` to `list`, most-recent-last, capped at `maxEntries`
 * (oldest dropped first). A back-to-back repeat of the exact same `hash`
 * (e.g. a redundant re-render of the current route) is a no-op — returns
 * the SAME array reference, so a caller re-rendering only on an actual
 * change (e.g. `!==` comparison) doesn't re-render for nothing. Revisiting
 * an EARLIER page later still appends a new entry (expected "recently
 * visited" semantics, not a deduped set) — only immediate repeats collapse.
 */
export function recordVisit(list, entry, maxEntries = MAX_ENTRIES) {
  if (!entry) return list;
  if (list.length > 0 && list[list.length - 1].hash === entry.hash) return list;
  const next = [...list, entry];
  return next.length > maxEntries ? next.slice(next.length - maxEntries) : next;
}
