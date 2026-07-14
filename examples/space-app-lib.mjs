// Beispiel 8: die gemeinsame Basis, auf der cms-lib.mjs, und potenziell
// auch todo-lib.mjs/forum-lib.mjs, aufsetzen können — der Teil einer
// "Space-App", der in JEDER von ihnen gleich aussieht, herausgezogen statt
// dreifach dupliziert:
//
//   - Nutzerverwaltung: wer im Space-Manifest unter `writers`/`readers`/
//     `admins` steht (Whitepaper §8.3) — hinzufügen/entfernen ist reines
//     Manifest-Patchen über `qu.addToRole()`/`qu.removeFromRole()`
//     (src/modules/spaces.js, seit Kurzem Teil des Frameworks selbst, NICHT
//     mehr hier neu erfunden), unabhängig davon, ob der Space eine
//     ToDo-Liste, ein Forum-Board oder eine CMS-Site ist. Die Funktionen
//     hier sind dünne, benannte Wrapper darüber (grantWriteAccess() ==
//     `addToRole(spaceId, 'writers', fp)`, setPublic(true) ==
//     `addToRole(spaceId, 'readers', '*')`, …) — derselbe eine generische
//     Mechanismus für alle drei Rollen, hier nur unter Namen zur Verfügung
//     gestellt, die eine App nicht bei jedem Aufruf neu benennen muss.
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

/** Nur von einem/einer Admin aufrufbar (Manifest-Änderungen brauchen Admin, nicht nur Writer, Whitepaper §8.3 — von `qu.addToRole()` selbst durchgesetzt, hier nicht doppelt geprüft). Fügt einen Fingerprint zu den Writern hinzu, ohne bestehende zu verlieren. */
export async function grantWriteAccess(qu, spaceId, fingerprint) {
  return qu.addToRole(spaceId, 'writers', fingerprint);
}

/** Das Gegenstück zu grantWriteAccess() — entfernt einen Fingerprint aus den Writern (siehe qu.removeFromRole()s Doku zu "kein Schutz vor Selbst-Aussperrung" in modules/spaces.js). */
export async function revokeWriteAccess(qu, spaceId, fingerprint) {
  return qu.removeFromRole(spaceId, 'writers', fingerprint);
}

/** Ist dieser Space öffentlich lesbar (`readers` enthält `'*'`)? */
export async function isPublic(qu, spaceId) {
  const manifest = await getManifest(qu, spaceId);
  return (manifest?.readers ?? []).includes('*');
}

/** Sichtbarkeit umschalten — `true`: für alle lesbar machen (`'*'` zu `readers` hinzufügen); `false`: `'*'` entfernen, danach nur noch die explizit unter `readers` gelisteten Fingerprints (siehe addReader()). Bestehende einzelne Reader-Fingerprints bleiben in beiden Richtungen erhalten. */
export async function setPublic(qu, spaceId, isPublicValue) {
  return isPublicValue ? qu.addToRole(spaceId, 'readers', '*') : qu.removeFromRole(spaceId, 'readers', '*');
}

/** Alle einzeln freigeschalteten Reader-Fingerprints (ohne `'*'`) — relevant, sobald ein Space NICHT öffentlich ist (siehe isPublic()/setPublic()). */
export async function listReaders(qu, spaceId) {
  const manifest = await getManifest(qu, spaceId);
  return (manifest?.readers ?? []).filter((fp) => fp !== '*');
}

/** Einen einzelnen Fingerprint zum Lesen freischalten — nur relevant, solange der Space NICHT öffentlich ist (siehe setPublic()); auf einem öffentlichen Space ist er ohnehin für alle lesbar. */
export async function addReader(qu, spaceId, fingerprint) {
  return qu.addToRole(spaceId, 'readers', fingerprint);
}

/** Das Gegenstück zu addReader(). */
export async function removeReader(qu, spaceId, fingerprint) {
  return qu.removeFromRole(spaceId, 'readers', fingerprint);
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
