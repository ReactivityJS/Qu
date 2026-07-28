// Deployment-wide theming: a single, publicly-readable, admin-only-writable
// QuBit (`relay-config/theme`) every app/service on a Qu deployment can read
// to apply the SAME look & feel — CSS custom properties, not a CSS file, so
// no app needs to ship its own stylesheet variant or know about any other
// app's styling. Same charter as this directory's other browser-only files
// (session-bootstrap.js, hash-router.js): DOM-dependent, not importable
// from Node — `applyTheme()` below is the one function here that touches
// `document`, everything else is a plain get/put/on wrapper around one
// fixed id, just like session-bootstrap.js's own shape.
//
// Deliberately NOT a `create*Plugin()` — this isn't per-Qu-instance state
// with its own sugar methods (like modules/contacts.js), it's one shared,
// deployment-global value every caller addresses by the same fixed id,
// exactly the same "plain functions taking `qu` as a parameter" shape
// session-bootstrap.js already uses for `loadOrCreateIdentity()`/`relayUrl()`.
//
// Server-side ACL (relay/relay.mjs): `relay-config/*` is writable only by a
// `relayAdmins` fingerprint, publicly readable — the exact same "public
// content, admin-only writes" shape `relay-services/<id>` already has, NOT
// the ephemeral encrypted `admin/` command channel (rate-limit/connection-
// limit/platform-modules use that instead, because those reconfigure an
// in-memory object live; a theme has no live object to reconfigure, it's
// just data every app reads) — so writing a theme is a plain signed
// `session.publish()`, no `encryptFor` needed (a color value is never
// confidential).
//
// Theme shape: a flat `{ [name]: cssValue }` object, e.g.
// `{ accent: '#ff6600', bg: '#101014', text: '#e8e8ec' }` — each key becomes
// the CSS custom property `--qu-<name>` on the applied target. No fixed set
// of required keys: an app's own stylesheet defines sensible fallbacks
// (`color: var(--qu-accent, #369)`) for any key a deployment never set.
const THEME_ID = 'relay-config/theme';

/** One-shot read of the current theme — `null` if this deployment never set one (an app's own default stylesheet then simply applies, unmodified). */
export async function getTheme(qu) {
  const q = await qu.get(THEME_ID);
  return q?.value ?? null;
}

/**
 * Sets the deployment-wide theme (a full replace, not a per-key patch — the
 * same "whole object, LWW" shape as any other config QuBit in this
 * codebase, e.g. modules/cms.js's `updateConfig()` for the partial-merge
 * counterpart if a caller wants one). Succeeds locally regardless of
 * whether the caller is actually a relayAdmins fingerprint (the same
 * Spaces-bootstrap-permits-a-manifestless-Space's-first-write reasoning
 * examples/relay-admin/app.mjs's own doc comment explains for
 * `admin/service/<id>`) — the relay's OWN ACL check is what actually
 * enforces this once the write reaches the network; a rejected write here
 * never throws locally, same "re-read afterward to confirm" caveat.
 */
export async function setTheme(qu, theme) {
  return qu.session.publish(THEME_ID, theme);
}

/**
 * Live subscription to the theme — `initial: true` (core/runtime.js)
 * delivers the CURRENT value immediately if one already exists, then every
 * future change. If no theme was EVER set, the initial catch-up simply has
 * nothing to deliver (there is no QuBit yet to match) — the callback then
 * only ever fires once an admin actually calls `setTheme()` for the first
 * time. `applyTheme()` below relies on exactly this: nothing ever being
 * applied is the correct behavior for a deployment that never configured a
 * theme (its own stylesheet defaults already stand, nothing to clear).
 */
export function onThemeChange(qu, callback, opts) {
  return qu.get(THEME_ID).on(callback, { initial: true, ...opts });
}

/**
 * Subscribes to the theme and keeps `target`'s (default: `document.documentElement`,
 * i.e. `:root`) CSS custom properties in sync — the one function in this
 * file that touches the DOM. A deployment that never configured a theme at
 * all never even invokes this callback (see onThemeChange()'s own doc
 * comment) — its own stylesheet defaults simply stand, untouched. An admin
 * EXPLICITLY clearing an already-set theme (`put(null)`) DOES invoke it
 * with a `null` value, which REMOVES every custom property this function
 * itself previously applied, reverting to those same stylesheet defaults
 * rather than leaving a stale value behind from before the clear.
 *
 * Returns the unsubscribe function `onThemeChange()` itself returns —
 * calling it stops live updates but deliberately does NOT revert already-
 * applied properties (same "stop listening, don't undo" contract every
 * other `on*Change()` in this codebase already has).
 */
export function applyTheme(qu, { target = document.documentElement } = {}) {
  let appliedKeys = [];
  return onThemeChange(qu, (q) => {
    for (const key of appliedKeys) target.style.removeProperty(`--qu-${key}`);
    const theme = q?.value;
    if (!theme) { appliedKeys = []; return; }
    appliedKeys = Object.keys(theme);
    for (const [key, value] of Object.entries(theme)) target.style.setProperty(`--qu-${key}`, value);
  });
}
