// Beispiel 7: eine CMS-Erweiterung — Inhalte, Templates UND die eigene
// Konfiguration liegen ALLE im selben Space wie jeder andere QU-Space
// (Whitepaper §8). Eine "Site" ist kein neues Kernkonzept, nur eine
// benannte Konvention über die üblichen fünf Verben (get/put/set/on/map),
// genau wie examples/todo-lib.mjs (Liste) oder examples/forum-lib.mjs
// (Board) — nur mit mehr als einer Sorte Inhalt unter einem Space:
//
//   <siteId>/cms/config           put() — { title, theme, language, navigationMode }
//   <siteId>/cms/templates/<name> put() — HTML-String, austauschbares Layout für Seiten
//   <siteId>/cms/pages/<slug>     put() — { title, template, blocks }, eine Seite
//   <siteId>/cms/nav              set() — { label, slug, order }, Menüeinträge (Tombstone-Delete wie todo-lib.mjs)
//   <siteId>/cms/state/route      put() — aktuell präsentierter Slug (nur im Präsentationsmodus relevant)
//
// `navigationMode` entscheidet, WIE Besucher zwischen Seiten wechseln —
// bewusst Teil der SITE-KONFIGURATION (in den Space geschrieben, von
// jedem Client reaktiv gelesen), nicht ein URL-Flag wie `?mode=...`: der
// Owner legt fest, wie seine Site funktioniert, und jeder Client, der sie
// besucht, übernimmt das automatisch (siehe cms-router.js, das diesen
// Wert reaktiv liest statt ihn nur einmal beim Laden zu prüfen):
//
//   "local"        — jeder Client navigiert für sich, per Hash-Route
//                    (`#<siteId>/<pfad>`, siehe cms-router.js).
//   "presentation" — alle Clients folgen der Route, die der Space-Owner
//                    (oder ein anderer Writer) unter cms/state/route
//                    einträgt, z. B. für einen Vortrag/Kiosk-Modus —
//                    eigene Klicks im Menü ändern dann nichts an der
//                    tatsächlich angezeigten Seite.
//
// Templates sind bewusst reine HTML-Strings, kein eigenes Format — eine
// Seite referenziert eines per Name (`page.template`). Das tatsächliche
// Rendern (Platzhalter/Bindings auflösen) ist bewusst NICHT Teil dieser
// Datei — reine Store-Logik, ganz ohne Browser testbar (siehe
// cms-lib.test.mjs) — sondern Sache des Browser-seitigen Routers/der App
// (examples/cms-router.js, examples/cms/app.mjs), analog zum Schnitt
// ui/bindings.js (Logik) vs. ui/components.js (DOM).

/**
 * Legt eine neue Site an — Space + initiale Konfiguration in einem
 * Aufruf. Rückgabe: die Site-ID (für den Link, wie überall sonst — siehe
 * todo-lib.mjs createTodoList()).
 *
 * `cms/state/route` wird hier bereits auf `defaultRoute` gesetzt, nicht
 * erst beim ersten presentRoute()-Aufruf: `on()` liefert ohne einen
 * bereits existierenden Wert KEINE initiale Zustellung (siehe
 * core/runtime.js — "initial: true" liefert nur, was bereits passt),
 * d. h. ein Client, der erst NACH dem Umschalten auf "presentation"
 * beitritt, würde sonst auf gar nichts warten, bis der Owner das erste
 * Mal presentRoute() aufruft. Mit einem definierten Startwert ab
 * Site-Erstellung ist der Präsentationsmodus jederzeit sofort nutzbar.
 */
export async function createSite(qu, { title = 'Neue Site', theme = 'light', language = 'de', navigationMode = 'local', defaultRoute = 'home', writers, readers = ['*'] } = {}) {
  const site = qu.createSpace({ writers: writers ?? [qu.fingerprint], readers }); // synchron — siehe modules/spaces.js
  await site.ready; // wirklich auf das Manifest warten, bevor die ID weitergegeben wird
  await site.get('cms/config').put({ title, theme, language, navigationMode });
  await site.get('cms/state/route').put(defaultRoute);
  return site.id;
}

/** Das Space-Manifest der Site (writers/readers/admins/createdAt) — u. a. um zu prüfen, wer schreiben darf, wie todo-lib.mjs getListManifest(). */
export async function getSiteManifest(qu, siteId) {
  const q = await qu.get(siteId);
  return q?.value ?? null;
}

/** Darf `qu` auf dieser Site schreiben (Konfiguration, Seiten, Menü, …)? */
export async function canWrite(qu, siteId) {
  const manifest = await getSiteManifest(qu, siteId);
  if (!manifest) return false; // kein Manifest = Site (für diesen Client) noch nicht sichtbar
  return manifest.writers.includes('*') || manifest.writers.includes(qu.fingerprint);
}

/** Nur von einem/einer Admin aufrufbar (Manifest-Änderungen brauchen Admin, nicht nur Writer — Whitepaper §8.3). Fügt einen Fingerprint zu den Writern hinzu, ohne bestehende zu verlieren. */
export async function grantWriteAccess(qu, siteId, fingerprint) {
  const manifest = await getSiteManifest(qu, siteId);
  if (!manifest) throw new Error('Site nicht gefunden — noch nicht gesynct?');
  const writers = manifest.writers.includes(fingerprint) ? manifest.writers : [...manifest.writers, fingerprint];
  return qu.get(siteId).put({ ...manifest, writers });
}

/** Aktuelle Konfiguration lesen — `null`, falls die Site (für diesen Client) noch nicht sichtbar ist. */
export async function getConfig(qu, siteId) {
  const q = await qu.get(`${siteId}/cms/config`);
  return q?.value ?? null;
}

/** Live-Abonnement auf die Konfiguration — liefert initial den aktuellen Stand, danach jede Änderung (z. B. einen Moduswechsel). */
export function onConfig(qu, siteId, callback, opts) {
  return qu.get(`${siteId}/cms/config`).on(callback, { initial: true, ...opts });
}

/** Einzelne Konfigurationsfelder ändern, ohne die übrigen zu verlieren — z. B. `updateConfig(qu, siteId, { theme: 'dark' })`. Jeder Writer der Site darf das (keine Admin-Sonderrolle, wie überall sonst in QU — siehe Whitepaper §8.3). */
export async function updateConfig(qu, siteId, patch) {
  const config = await getConfig(qu, siteId);
  if (!config) throw new Error('Site nicht gefunden — noch nicht gesynct?');
  return qu.get(`${siteId}/cms/config`).put({ ...config, ...patch });
}

/** Navigationsmodus umschalten — dünner, selbsterklärender Wrapper um updateConfig(), mit Validierung der beiden erlaubten Werte. */
export async function setNavigationMode(qu, siteId, mode) {
  if (mode !== 'local' && mode !== 'presentation') {
    throw new Error(`Ungültiger navigationMode: "${mode}" (erwartet "local" oder "presentation")`);
  }
  return updateConfig(qu, siteId, { navigationMode: mode });
}

/** Ein Template (HTML-String) anlegen/überschreiben — ein benannter, veränderlicher Wert, wie jede Konfiguration (put(), kein set()). */
export async function setTemplate(qu, siteId, name, html) {
  return qu.get(`${siteId}/cms/templates/${name}`).put(html);
}

/** Ein Template lesen — `null`, falls es (noch) nicht existiert. */
export async function getTemplate(qu, siteId, name) {
  const q = await qu.get(`${siteId}/cms/templates/${name}`);
  return q?.value ?? null;
}

/** Live-Abonnement auf ein Template — z. B. damit eine gerade offene Seite sofort neu rendert, wenn jemand das benutzte Layout ändert. */
export function onTemplate(qu, siteId, name, callback, opts) {
  return qu.get(`${siteId}/cms/templates/${name}`).on(callback, { initial: true, ...opts });
}

/**
 * Eine Seite anlegen/überschreiben. `blocks` bleibt EIN eingebettetes
 * Objekt (nicht Blatt-per-Feld wie bindObject()) — eine Seite wird
 * typischerweise als Ganzes von einer Person im Editor gespeichert, kein
 * Fall von "mehrere Leute bearbeiten gleichzeitig verschiedene Felder"
 * (siehe ui/bindings.js's Doku zu genau dieser Abwägung).
 */
export async function setPage(qu, siteId, slug, { title = slug, template = 'default', blocks = {} } = {}) {
  return qu.get(`${siteId}/cms/pages/${slug}`).put({ title, template, blocks });
}

/** Eine Seite lesen — `null`, falls sie (noch) nicht existiert. */
export async function getPage(qu, siteId, slug) {
  const q = await qu.get(`${siteId}/cms/pages/${slug}`);
  return q?.value ?? null;
}

/** Live-Abonnement auf GENAU eine Seite (das, was der Router beim Anzeigen einer Route tatsächlich braucht). */
export function onPage(qu, siteId, slug, callback, opts) {
  return qu.get(`${siteId}/cms/pages/${slug}`).on(callback, { initial: true, ...opts });
}

/** Ein neuer Menüeintrag — set(), weil mehrere Redakteur:innen unabhängig voneinander gleichzeitig Einträge hinzufügen können (kollisionssicher, wie todo-lib.mjs addItem()). Rückgabe: die QuBit-ID des Eintrags (für removeNavItem()). */
export async function addNavItem(qu, siteId, { label, slug, order = 0 }) {
  const { qubit } = await qu.get(`${siteId}/cms/nav`).set({ label, slug, order });
  return qubit.id;
}

/** Kein echtes Löschen (QuBits sind unveränderlich) — ein Tombstone-Flag, das listNav() beim Lesen herausfiltert (gleiches Muster wie todo-lib.mjs deleteItem()). */
export async function removeNavItem(qu, navItemId) {
  const q = await qu.get(navItemId);
  if (!q) return;
  return qu.get(navItemId).put({ ...q.value, deleted: true });
}

/** Alle (nicht gelöschten) Menüeinträge, nach `order` sortiert — einmalige Anfrage. */
export async function listNav(qu, siteId) {
  const rows = await qu.session.query(`${siteId}/cms/nav/**`);
  return rows.filter((q) => !q.value.deleted).sort((a, b) => a.value.order - b.value.order);
}

/** Live-Abonnement auf das Menü — liefert erst, was bereits existiert, danach laufend Neues (map()s Default). */
export function onNav(qu, siteId, callback, opts) {
  return qu.get(`${siteId}/cms/nav`).map(callback, { deep: true, ...opts });
}

/**
 * Präsentationsmodus: den aktuell gezeigten Slug für ALLE Besucher
 * festlegen. Nur sinnvoll, wenn `navigationMode === "presentation"` (siehe
 * cms-router.js) — technisch aber unabhängig davon durchsetzbar, damit ein
 * Owner den Zustand schon VOR dem Umschalten vorbereiten kann.
 */
export async function presentRoute(qu, siteId, slug) {
  return qu.get(`${siteId}/cms/state/route`).put(slug);
}

/** Live-Abonnement auf die präsentierte Route. */
export function onPresentedRoute(qu, siteId, callback, opts) {
  return qu.get(`${siteId}/cms/state/route`).on(callback, { initial: true, ...opts });
}
