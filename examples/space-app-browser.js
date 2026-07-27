// Browser-seitiger Gegenpart zu space-app-lib.mjs — derselbe Schnitt wie
// ui/bindings.js (DOM-frei) vs. ui/components.js (browser-only) und
// cms-lib.mjs vs. cms-router.js: space-app-lib.mjs kennt kein `window`,
// dieses Modul schon (Identity-Persistenz, Relay-URL, Hash-Navigation).
//
// `loadOrCreateIdentity`/`relayUrl` selbst leben inzwischen in
// `src/ui/session-bootstrap.js` (siehe dort) — generisch genug, um zum
// Framework zu gehören statt zu den Beispielen, und der Ort, den eine NEUE
// App gegen dieses Repo importieren sollte. Hier nur re-exportiert, damit
// jedes bestehende `examples/<app>/app.mjs`, das weiterhin `from
// '../space-app-browser.js'` importiert, unverändert weiterläuft.
// `watchRoute`/`navigate` bleiben HIER (nicht in src/ui/): sie hängen an
// space-app-lib.mjs's `parseHashRoute`/`buildHashRoute`, die (noch) reines
// Beispiel-Code sind, kein Teil des Frameworks.
export { loadOrCreateIdentity, relayUrl, ECOSYSTEM_IDENTITY_KEY } from '../src/ui/session-bootstrap.js';
import { parseHashRoute, buildHashRoute } from './space-app-lib.mjs';

/**
 * Live-Abonnement auf `window.location.hash`, bereits in `{ spaceId, path }`
 * übersetzt (siehe space-app-lib.mjs's parseHashRoute()) — WAS eine App
 * mit `path` anfängt, ist absichtlich nicht Sache dieses Moduls (siehe
 * cms-router.js für ein Beispiel, das zusätzlich zwischen lokaler und
 * Präsentations-Navigation unterscheidet, indem es `onRoute` selbst noch
 * einmal umschichtet). `defaultSpaceId`: welcher Space geöffnet wird,
 * solange der Hash selbst keine Space-Id trägt (z. B. beim allerersten
 * Laden ohne `#...` in der URL) — optional, für eine App mit genau einer
 * festen Space. Rückgabe: eine Unsubscribe-Funktion.
 */
export function watchRoute({ defaultSpaceId = null, onRoute }) {
  function onHashChange() {
    const { spaceId, path } = parseHashRoute(location.hash);
    const id = spaceId || defaultSpaceId;
    if (!id) return;
    onRoute({ spaceId: id, path });
  }
  window.addEventListener('hashchange', onHashChange);
  onHashChange();
  return () => window.removeEventListener('hashchange', onHashChange);
}

/** Setzt den Hash auf `#<spaceId>` oder `#<spaceId>/<path>` — der normale Weg, wie ein Navigationslink eine neue Route auslöst. */
export function navigate(spaceId, path = '') {
  window.location.hash = buildHashRoute(spaceId, path);
}
