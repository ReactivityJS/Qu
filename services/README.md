# App-/Service-Template

Jede App in QUniverse lebt in einem eigenen Verzeichnis unter `services/`,
nach demselben Muster, das sich bereits in Qu's eigenen `examples/`
etabliert hat (`<app>-lib.mjs` + `<app>-lib.test.mjs` + `app.mjs`) —
erweitert um ein `manifest.mjs`, mit dem sich eine App gegenüber der
Ökosystem-Shell registriert.

**`services/hello-world/` ist das minimale, echte, laufende
Referenzbeispiel** für all das unten Beschriebene — Qu-Components
(`<qu-view>`/`<qu-bind>`) statt manueller `get()`/`on()`/`put()`-Plumbing,
ein per-User-Einstellungsbereich, ein globaler admin-only-Einstellungsbereich,
In-App-Navigation über `segments`, und (siehe `manifest.mjs`s
`hasSettings`/`hasAdmin`) Direkt-Links aus `services/app-directory` in genau
diese beiden Bereiche. Zum Kopieren für eine neue App, nicht nur zum Lesen.

```
services/<name>/<name>-lib.mjs      Reine Logik, Node-testbar (put/set/Zeit-Sharding
                                     nach Qu-README §7). Baut auf Qu's
                                     src/modules/space-membership.js (ensureSpace/
                                     notifyMembers), src/modules/profiles.js
                                     (Verzeichnis-Teilnahme) und src/modules/spaces.js
                                     (Rechteverwaltung) auf, statt diese neu zu bauen.
services/<name>/<name>-lib.test.mjs node --test, echte In-Memory-Qu-Instanzen
                                     (kein Mocking — Qu-Repo-Konvention).
services/<name>/app.mjs             Browser-UI — für einen `entry`-basierten Standalone-Service:
                                     importiert ../../src/ui/session-bootstrap.js (geteilte
                                     Identität). Für einen `mount`-basierten Service (siehe unten):
                                     exportiert nur `mount(container, {qu, spaceId, appId, segments})`,
                                     die Shell übergibt bereits ein verbundenes `qu` — kein eigener
                                     Bootstrap nötig.
services/<name>/manifest.mjs        Exportiert das App-Manifest-Objekt (siehe unten).
services/<name>/index.html          Eigenständige Shell — nur falls die App zusätzlich
                                     als installierbare Standalone-PWA laufen soll.
```

## App-Manifest

Das Manifest-Format ist in Qu selbst definiert
(`../server/service-registry.mjs`, Dateikopf-Kommentar) — additiv zum
bestehenden Service-Katalog-Format:

```js
// services/<name>/manifest.mjs
export default {
  id: 'forum',
  category: 'service',
  label: 'Forum',
  description: 'Zeit-geshardetes Forum mit Boards/Topics.',
  mount: '/services/forum/app.mjs', // bevorzugt: In-Shell-Mount, kein Seitenwechsel (siehe unten)
  // entry: '/services/forum/index.html', // Alternative: eigenständige Seite (Fallback für nicht migrierte Services)
  icon: '💬',
  navOrder: 10,
  spaceMode: 'perInstance', // 'fixed' | 'perUser' | 'perInstance' — siehe Qu's APP-GUIDE.md Schritt 3
  notificationTopics: ['reply', 'mention'],
  usesCms: false,
  // Beide optional — nur setzen, wenn app.mjs tatsächlich etwas unter
  // `#/<id>/settings` bzw. `#/<id>/admin` mountet (siehe services/hello-world/
  // für das lauffähige Beispiel). services/app-directory/app.mjs liest diese
  // Felder und zeigt dann eine ⚙️/🛠️-Direkt-Verknüpfung pro Zeile —
  // `hasAdmin`s Verknüpfung zusätzlich nur für eine QU_RELAY_ADMINS-Identität.
  hasSettings: true,
  hasAdmin: true,
};
```

Registrierung in `../index.js` (dem einen Server-Prozess, der Relay UND
QUniverse-Shell bedient): den Manifest-Export in
`createServiceRegistry(definitions)`s Array aufnehmen (code-seitig, wie
jeder andere `service-registry.mjs`-Eintrag) — oder, für einen rein
link-basierten Eintrag ohne eigenen Code in diesem Repo, als
laufzeit-veränderlicher `relay-services/<id>`-QuBit (siehe
`service-registry.mjs`s `attachStore()`).

## Ökosystem-Shell (existiert bereits)

`../index.html` + `../app.mjs` + `../shell/` (`qu-app-shell.mjs`,
`qu-nav-dropdown.mjs`, `qu-notification-badge.mjs`, `identity-screen.mjs`)
bilden die Willkommensseite: echter Router-Dispatch (`../src/ui/router.js`),
Navigations-Dropdown (liest `/relay/services`, filtert/sortiert nach den
Manifest-Feldern oben), zentrale Benachrichtigungs-Badge (`onNotification()`/
`onSpaceInvite()`, `../src/modules/notifications.js`), und `~<fp>`/`u/<fp>`-
Identity-Viewer-Routen (Profilkarte, Verzeichnis-Sichtbarkeits-Toggle für
die eigene Identität, App-Teilnahme via `listProfileAttrs`).

**Ein Service mit `mount` wird direkt IN die Shell eingebettet** (per
dynamischem `import()`, siehe `qu-app-shell.mjs`s `_mountApp()`) — dieselbe
Identität/Verbindung/Runtime bleibt für die ganze Sitzung bestehen, kein
Seitenwechsel. Ein Service mit nur `entry` (kein `mount`) wird stattdessen
per `location.href = entry` als eigenständige Seite geöffnet — Fallback für
einen noch nicht auf den Mount-Vertrag migrierten Service, nicht der
Regelfall für neue Services.
