// Beispiel 8: die gemeinsame Basis, auf der cms-lib.mjs, und potenziell
// auch todo-lib.mjs/forum-lib.mjs, aufsetzen können — der Teil einer
// "Space-App", der in JEDER von ihnen gleich aussieht, herausgezogen statt
// dreifach dupliziert:
//
//   - Nutzerverwaltung: schreiben darf, wer im Space-Manifest unter
//     `writers` steht (Whitepaper §8.3) — hinzufügen/entfernen ist reines
//     Manifest-Patchen, unabhängig davon, ob der Space eine ToDo-Liste,
//     ein Forum-Board oder eine CMS-Site ist.
//   - Navigation: EIN einheitliches Adressformat für JEDE Space-App,
//     `#<spaceId>/<pfad>` — welcher Space UND welcher Unterpfad darin, in
//     einem Hash. `parseHashRoute()`/`buildHashRoute()` sind reine
//     String-Funktionen (kein `window`, siehe Klassendoku unten), was
//     eine konkrete App mit `path` anfängt (eine CMS-Seite? ein
//     ToDo-Filter? gar nichts, weil die App nur einen Space kennt) bleibt
//     bewusst ihre eigene Sache — diese Datei entscheidet nur, WIE die
//     Id aus der URL herausgeschält wird, nicht was sie bedeutet.
//
// Bewusst NICHT Teil dieser Datei: ein gemeinsames "Content"-Schema für
// Seiten/ToDo-Items/Forum-Posts. Die drei haben unterschiedliche
// Schreibmuster aus gutem Grund (todo-lib.mjs: set() + Tombstone-Delete;
// forum-lib.mjs: set() + Zeit-Sharding, um endloses Wachstum zu
// vermeiden; cms-lib.mjs: put() pro Slug, ganze Seite auf einmal) — sie
// in ein universelles Objekt zu pressen würde eins davon strukturell
// verschlechtern. "So viele Primitive wie nötig, so wenige wie möglich"
// gilt hier genauso wie im Core selbst: eine gemeinsame SCHALE
// (Nutzerverwaltung + Navigation), aber eigene, fokussierte Content-Libs
// obendrauf — kein Monolith.
//
// Der Browser-seitige Gegenpart (Identity-Bootstrap, Relay-URL,
// `watchRoute()`/`navigate()` mit echtem `window`/Hash) liegt getrennt in
// space-app-browser.js — derselbe Schnitt wie überall sonst im Repo
// (ui/bindings.js vs. ui/components.js, cms-lib.mjs vs. cms-router.js):
// diese Datei bleibt vollständig ohne Browser mit `node --test` prüfbar.

/** Das Space-Manifest (writers/readers/admins/createdAt) — `null`, falls der Space (für diesen Client) noch nicht sichtbar ist. */
export async function getManifest(qu, spaceId) {
  const q = await qu.get(spaceId);
  return q?.value ?? null;
}

/** Darf `qu` in diesem Space schreiben? */
export async function canWrite(qu, spaceId) {
  const manifest = await getManifest(qu, spaceId);
  if (!manifest) return false; // kein Manifest = Space (für diesen Client) noch nicht sichtbar
  return manifest.writers.includes('*') || manifest.writers.includes(qu.fingerprint);
}

/** Ist `qu` Admin dieses Space (darf also selbst Nutzer hinzufügen/entfernen, Whitepaper §8.3)? */
export async function isAdmin(qu, spaceId) {
  const manifest = await getManifest(qu, spaceId);
  return manifest?.admins?.includes(qu.fingerprint) ?? false;
}

/** Alle aktuellen Writer-Fingerprints (ohne das `'*'`-Sonderzeichen für "offen für alle") — für eine Nutzerverwaltungs-Ansicht. */
export async function listWriters(qu, spaceId) {
  const manifest = await getManifest(qu, spaceId);
  return (manifest?.writers ?? []).filter((fp) => fp !== '*');
}

/** Nur von einem/einer Admin aufrufbar (Manifest-Änderungen brauchen Admin, nicht nur Writer). Fügt einen Fingerprint zu den Writern hinzu, ohne bestehende zu verlieren. */
export async function grantWriteAccess(qu, spaceId, fingerprint) {
  const manifest = await getManifest(qu, spaceId);
  if (!manifest) throw new Error('Space nicht gefunden — noch nicht gesynct?');
  const writers = manifest.writers.includes(fingerprint) ? manifest.writers : [...manifest.writers, fingerprint];
  return qu.get(spaceId).put({ ...manifest, writers });
}

/**
 * Das Gegenstück zu grantWriteAccess() — nur von einem/einer Admin
 * aufrufbar, entfernt einen Fingerprint aus den Writern. Ein Admin sich
 * selbst zu entfernen ist technisch erlaubt (kein Schutz davor hier) —
 * ein Space ohne verbliebenen Admin bleibt les-, aber für niemanden mehr
 * administrierbar, dieselbe bewusste "keine Sonderfälle"-Haltung wie
 * beim Bootstrap-Verhalten ohne Manifest (modules/spaces.js).
 */
export async function revokeWriteAccess(qu, spaceId, fingerprint) {
  const manifest = await getManifest(qu, spaceId);
  if (!manifest) throw new Error('Space nicht gefunden — noch nicht gesynct?');
  const writers = manifest.writers.filter((fp) => fp !== fingerprint);
  return qu.get(spaceId).put({ ...manifest, writers });
}

/**
 * `#<spaceId>/<pfad>` -> `{ spaceId, path }`, `path` als leerer String,
 * falls der Hash keinen Unterpfad trägt (z. B. nur `#<spaceId>`) — eine
 * App entscheidet selbst, was ein leerer Pfad bedeutet (Startseite? kein
 * Unterpfad-Konzept, wie beim Forum-Board?). Leerer/fehlender Hash ->
 * `{ spaceId: null, path: '' }`.
 */
export function parseHashRoute(hash) {
  const raw = (hash ?? '').replace(/^#/, '');
  const [spaceId, ...rest] = raw.split('/');
  return { spaceId: spaceId || null, path: rest.join('/') };
}

/** Das Gegenstück zu parseHashRoute() — baut `#<spaceId>` (ohne `path`) oder `#<spaceId>/<path>`. */
export function buildHashRoute(spaceId, path = '') {
  return path ? `#${spaceId}/${path}` : `#${spaceId}`;
}
