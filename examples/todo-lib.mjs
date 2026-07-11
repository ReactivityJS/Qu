// Beispiel 3: Eine teilbare ToDo-Liste — die Logik, getrennt von der
// Oberfläche, damit sie sich auch ganz ohne Browser testen/nachvollziehen
// lässt (siehe examples/todo-lib.test.mjs).
//
// Kernidee: eine ToDo-Liste ist nichts weiter als ein generischer Space
// (siehe Whitepaper §8). "Teilen" heißt: die Space-ID (eine UUID) in einen
// Link packen. "Schreibrecht per Fingerprint erteilen" heißt: den
// Fingerprint der anderen Person zur `writers`-Liste des Space-Manifests
// hinzufügen — nur der/die Admin(s) dürfen das (siehe §8.3), alle anderen
// dürfen die Liste zwar lesen (readers: ['*']), aber nicht verändern, bis
// sie freigeschaltet sind.

/** Erstellt eine neue, leere Liste. Rückgabe: die Space-ID (für den Link). */
export async function createTodoList(qu) {
  return qu.createSpace({ writers: [qu.fingerprint], readers: ['*'] });
}

/** Aktueller Zustand des Manifests — u. a. um zu prüfen, wer schreiben darf. */
export async function getListManifest(qu, listId) {
  const q = await qu.get(listId);
  return q?.value ?? null;
}

export async function canWrite(qu, listId) {
  const manifest = await getListManifest(qu, listId);
  if (!manifest) return false; // kein Manifest = Space existiert (für diesen Client) noch nicht sichtbar
  return manifest.writers.includes('*') || manifest.writers.includes(qu.fingerprint);
}

/**
 * Nur von einem/einer Admin aufrufbar (siehe §8.3 — Manifest-Änderungen
 * brauchen Admin, nicht nur Writer). Fügt einen Fingerprint zu den Writern
 * hinzu, ohne bestehende Writer/Admins zu verlieren.
 */
export async function grantWriteAccess(qu, listId, fingerprint) {
  const manifest = await getListManifest(qu, listId);
  if (!manifest) throw new Error('Liste nicht gefunden — noch nicht gesynct?');
  const writers = manifest.writers.includes(fingerprint) ? manifest.writers : [...manifest.writers, fingerprint];
  return qu.publish(listId, { ...manifest, writers });
}

/** Ein neuer Eintrag — append(), weil mehrere Personen unabhängig voneinander Einträge hinzufügen können (kollisionssicher, siehe §7.2). */
export async function addItem(qu, listId, text) {
  return qu.append(`${listId}/items`, { text, done: false });
}

/** Status ändern (oder löschen) ist publish() auf die EXISTIERENDE Item-ID — ein benannter, veränderlicher Wert, kein neuer Eintrag. Jeder Writer der Liste darf das, nicht nur die ursprüngliche Autorin. */
export async function setItemDone(qu, itemId, done) {
  const q = await qu.get(itemId);
  if (!q) throw new Error('Eintrag nicht gefunden');
  return qu.publish(itemId, { ...q.value, done });
}

/** Kein echtes "Löschen" (QuBits sind unveränderlich) — ein Tombstone-Flag, das die Liste beim Anzeigen herausfiltert. */
export async function deleteItem(qu, itemId) {
  const q = await qu.get(itemId);
  if (!q) return;
  return qu.publish(itemId, { ...q.value, deleted: true });
}

/** Alle (nicht gelöschten) Einträge, älteste zuerst. */
export async function listItems(qu, listId) {
  const rows = await qu.query(`${listId}/items/**`);
  return rows.filter((q) => !q.value.deleted).sort((a, b) => a.ts - b.ts);
}

export function onItemsChange(qu, listId, callback) {
  return qu.on(`${listId}/items/**`, callback);
}
