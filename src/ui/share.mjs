// One shared way to share content out of any Qu app — generalizes the
// pattern `examples/hunt/app.mjs` grew locally (a non-exported
// `setupShareButtons()`, feature-detecting `navigator.share`) into a
// reusable, importable module, so future apps/mount modules don't each
// reinvent the same feature-detect/fallback dance. Lives in `src/ui/`
// alongside this directory's other browser-FACING files (session-
// bootstrap.js, theme.js), but — unlike those — never touches `document`/
// `window`, only the global `navigator` behind an explicit
// `typeof navigator !== 'undefined'` guard, so it's genuinely testable
// under `node --test` with a minimal mock (see share.test.mjs), not just
// verified in a real browser.
//
// Deliberately just TWO primitive functions, no button-wiring/UI assumed —
// each caller already owns its own button/status display (a "Teilen"
// button next to a profile link, a share icon on a CMS page, …), same
// "granular primitive, not a turnkey widget" stance viewKey()/viewObject()
// already take over a full form component. `attachShareButton()`-style
// sugar can be added later if a second real caller shows it'd actually
// help — nothing here today needs it.

/** Whether the Web Share API is available at all — feature-detect once, reuse everywhere (e.g. to decide whether to even render a "Teilen" button). */
export function canShare() {
  return typeof navigator !== 'undefined' && 'share' in navigator;
}

/**
 * Shares `{title, text, url}` via the Web Share API where available; falls
 * back to copying the single most useful string (`url`, else `text`, else
 * `title`) to the clipboard where `navigator.clipboard.writeText` exists.
 * Returns a status string instead of throwing for the common, non-error
 * outcomes a caller actually needs to react to differently:
 *   - `'shared'`    — the OS share sheet completed (user picked a target).
 *   - `'cancelled'` — the user dismissed the share sheet — NOT an error,
 *     same "user declined, not a failure" stance every other user-facing
 *     cancellation in this codebase already takes (e.g. `examples/hunt/
 *     app.mjs`'s own `.catch(() => {})` for this exact case).
 *   - `'copied'`    — no Share API, but the fallback string landed on the
 *     clipboard — a caller shows "Link kopiert" or similar.
 *   - `'unsupported'` — neither mechanism is available in this browser —
 *     a caller falls back to its own visible, selectable link/text.
 *   - `'noop'`      — nothing to share at all (`title`/`text`/`url` all
 *     empty) — a caller's own bug, not a runtime failure worth throwing on.
 * Any OTHER rejection from `navigator.share()` (a real failure, not a
 * cancellation) is re-thrown — this function only ever swallows the one
 * outcome ("user changed their mind") that isn't actually an error.
 */
export async function shareContent({ title, text, url } = {}) {
  if (canShare()) {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  const fallbackText = url || text || title || '';
  if (!fallbackText) return 'noop';
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(fallbackText);
    return 'copied';
  }
  return 'unsupported';
}
