// Beispiel 6: mehrere Sub-Spaces von einem App-Space aus referenzieren —
// "App hat mehrere Boards/ToDo-Listen" statt "App IST ein Space" (siehe
// examples/app-space-lib.mjs für den Ein-Space-Fall).
//
// Kernidee, kein neuer Mechanismus: eine Id ist eine Id. Ein Space kann
// die Id eines anderen Spaces ganz gewöhnlich als Feld in seinen eigenen
// Daten tragen — `qu.get(diese-id)` navigiert dorthin, unabhängig davon,
// ob "diese-id" aus dem eigenen Space stammt oder nicht. Dieses Modul ist
// nur eine dünne, benannte Konvention obendrauf:
//
//   App-Space --(Label)--> Sub-Space-Id --(qu.get)--> Sub-Space (eigenes Manifest)
//
// Jeder Sub-Space wird ganz normal mit `qu.createSpace({ writers, readers })`
// angelegt (frische, zufällige Id — viele unabhängige Räume, siehe
// examples/todo-lib.mjs) und bekommt dadurch sein EIGENES, vom App-Space
// komplett unabhängiges Manifest: ein öffentliches Board und eine private
// ToDo-Liste können im selben App-Space-Index nebeneinander stehen, mit
// völlig unterschiedlichen readers/writers.
//
// WICHTIG, leicht zu übersehen: der Index-EINTRAG (Label + Sub-Space-Id)
// ist nur so privat wie der App-Space selbst (dessen `readers`) — NICHT so
// privat wie der referenzierte Sub-Space. Wer den App-Space lesen darf,
// sieht IMMER Label + Id jedes registrierten Sub-Space, auch wenn er den
// referenzierten Sub-Space selbst nicht lesen darf (dessen INHALT bleibt
// aber durch dessen eigene ACL geschützt — nur Existenz+Label sind
// sichtbar, siehe space-index-lib.test.mjs). Für einen wirklich geheimen
// Sub-Space (dessen Existenz selbst verborgen bleiben soll) den Index-
// Eintrag NICHT im offenen App-Space ablegen, sondern z. B. direkt unter
// den `readers` des Sub-Space selbst, oder per Direktnachricht/Link
// verteilen statt über einen geteilten Index.

/**
 * Menschenlesbares Label als EIGENES Blatt unter einem Space, nicht Teil
 * des Manifests — dieselbe Konvention wie `~<fp>/alias` fürs Nutzerprofil
 * (README Abschnitt 2). Wichtig, weil ins Manifest übergebene Extra-Felder
 * (z. B. `qu.createSpace({ writers, readers, label })`) stillschweigend
 * verworfen werden — `buildManifest()` (modules/spaces.js) übernimmt nur
 * writers/readers/admins/createdAt, sonst nichts.
 */
export async function setLabel(space, label) {
  return space.get('label').put(label);
}

/** Das Label eines Space lesen — `null`, falls noch keins gesetzt wurde. */
export async function getLabel(space) {
  const q = await space.get('label');
  return q?.value ?? null;
}

/**
 * Einen Sub-Space im Index eines App-/Eltern-Space registrieren —
 * `indexNode` ist typischerweise `appSpace.get('boards')` o. ä.
 * `set()`, weil mehrere Nutzer unabhängig voneinander gleichzeitig neue
 * Sub-Spaces registrieren können, ohne sich gegenseitig zu überschreiben.
 */
export async function registerSpace(indexNode, label, subSpaceId) {
  return indexNode.set({ label, spaceId: String(subSpaceId) });
}

/** Alle registrierten Sub-Spaces, alphabetisch nach Label — einmalige Anfrage. */
export async function listSpaces(indexNode) {
  const rows = await indexNode.session.query(`${indexNode.id}/**`);
  return rows.map((q) => q.value).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** Live-Abonnement auf neu registrierte Sub-Spaces — liefert erst, was bereits registriert ist, danach laufend Neues (map()s Default). */
export function onSpaceRegistered(indexNode, callback) {
  return indexNode.map(callback);
}
