// Browser-seitiges Gegenstück zu cms-lib.mjs — genau der Schnitt, den
// src/ui/bindings.js (DOM-frei, testbar) vs. src/ui/components.js
// (browser-only, `window`/DOM) bereits vormachen: cms-lib.mjs kennt kein
// `window`, dieses Modul schon (Hash-Routing) — deliberately getrennt.
//
// watchRoute() entscheidet bei JEDER Route-Auflösung neu, WELCHE Quelle
// gilt — nicht einmalig beim Start, sondern reaktiv über onConfig()
// (cms-lib.mjs), weil ein Owner den navigationMode jederzeit umschalten
// kann und jeder bereits offene Client sofort folgen soll, ohne Reload:
//
//   "local"        — die Route kommt aus dem Browser-Hash, Format
//                    `#<siteId>/<pfad>` (Site-ID UND Unterpfad in einem
//                    Hash, damit ein einziger, generischer Bootloader per
//                    Link jede beliebige Site öffnen kann — siehe
//                    examples/cms/index.html). `hashchange` treibt neue
//                    Aufrufe von `onRoute()`.
//   "presentation" — die Route kommt aus cms/state/route (onPresentedRoute()
//                    in cms-lib.mjs); der lokale Hash-Unterpfad wird
//                    ignoriert — eigene Klicks im Menü ändern nichts an
//                    der tatsächlich angezeigten Seite, wie im Whitepaper/
//                    in der Machbarkeitsstudie beschrieben.
//
// `onRoute({ siteId, route, mode })` wird bei jeder relevanten Änderung
// aufgerufen — Site-Wechsel (neue Site-ID im Hash), Konfigurationsänderung
// (Moduswechsel) und, je nach Modus, Hash- oder präsentierter-Route-
// Änderung. Rückgabe: eine Unsubscribe-Funktion, die alle drei möglichen
// inneren Abonnements sauber beendet (dieselbe disconnectedCallback()-
// Pflicht wie überall sonst in QU — siehe ui/components.js).

import { onConfig, onPresentedRoute } from './cms-lib.mjs';

function parseHash() {
  const raw = window.location.hash.slice(1);
  const [siteId, ...rest] = raw.split('/');
  return { siteId: siteId || null, route: rest.join('/') || 'home' };
}

/**
 * `defaultSiteId`: welche Site geöffnet wird, solange der Hash selbst
 * keine Site-ID trägt (z. B. beim allerersten Laden ohne `#...` in der
 * URL) — optional, für eine App mit genau einer festen Site.
 */
export function watchRoute(qu, { defaultSiteId = null, onRoute }) {
  let siteId = null;
  let mode = 'local';
  let offConfig = null;
  let offPresented = null;
  let cancelled = false;

  function emitLocal() {
    if (cancelled || mode !== 'local') return;
    const { route } = parseHash();
    onRoute({ siteId, route, mode });
  }

  function connectSite(id) {
    if (cancelled || id === siteId) return;
    siteId = id;
    offConfig?.();
    offConfig = onConfig(qu, id, (q) => {
      if (cancelled) return;
      mode = q?.value?.navigationMode === 'presentation' ? 'presentation' : 'local';
      offPresented?.();
      offPresented = null;
      if (mode === 'presentation') {
        offPresented = onPresentedRoute(qu, id, (q2) => {
          if (cancelled) return;
          onRoute({ siteId: id, route: q2?.value ?? 'home', mode });
        });
      } else {
        emitLocal();
      }
    });
  }

  function onHashChange() {
    const { siteId: hashSiteId, route } = parseHash();
    const id = hashSiteId || defaultSiteId;
    if (!id) return;
    if (id !== siteId) { connectSite(id); return; } // connectSite() itself emits once its config arrives
    if (mode === 'local') onRoute({ siteId: id, route, mode });
  }

  window.addEventListener('hashchange', onHashChange);
  onHashChange();

  return () => {
    cancelled = true;
    window.removeEventListener('hashchange', onHashChange);
    offConfig?.();
    offPresented?.();
  };
}

/** Setzt den lokalen Hash auf `#<siteId>/<route>` — der normale Weg, wie ein Navigationslink im "local"-Modus eine neue Route auslöst (im "presentation"-Modus ohne Wirkung auf die angezeigte Seite, siehe Moduldoku oben, aber weiterhin nützlich, damit die Adresszeile/Zurück-Taste konsistent bleibt). */
export function navigate(siteId, route) {
  window.location.hash = `${siteId}/${route}`;
}
