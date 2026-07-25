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
//
// Nutzerverwaltung (Writer hinzufügen/wer darf schreiben) ist NICHT hier
// neu implementiert, sondern aus space-app-lib.mjs importiert — dieselbe
// Logik, die jede Space-App braucht (siehe deren Moduldoku). Wichtig: das
// ersetzt eine frühere, eigene grantWriteAccess()-Implementierung hier, die
// das Manifest direkt patchte (`qu.get(listId).put({...manifest, writers})`)
// statt über `qu.addToRole()` zu gehen — funktional fast gleich, aber eine
// echte Konsistenzlücke gegenüber der vom Framework zentral gepflegten
// Rollen-Logik.
import { createSpaceApp, getManifest, canWrite, grantWriteAccess } from './space-app-lib.mjs';

export { canWrite, grantWriteAccess };
/** Alias für space-app-lib.mjs's getManifest() — hier unter dem in diesem Modul etablierten Namen. */
export const getListManifest = getManifest;

/** Erstellt eine neue, leere Liste. Rückgabe: die Space-ID (für den Link). */
export async function createTodoList(qu) {
  return createSpaceApp(qu);
}

/** Ein neuer Eintrag — set(), weil mehrere Personen unabhängig voneinander Einträge hinzufügen können (kollisionssicher, siehe §7.2). */
export async function addItem(qu, listId, text) {
  return qu.get(`${listId}/items`).set({ text, done: false });
}

/** Status ändern (oder löschen) ist put() auf die EXISTIERENDE Item-ID — ein benannter, veränderlicher Wert, kein neuer Eintrag. Jeder Writer der Liste darf das, nicht nur die ursprüngliche Autorin. */
export async function setItemDone(qu, itemId, done) {
  const q = await qu.get(itemId);
  if (!q) throw new Error('Eintrag nicht gefunden');
  return qu.get(itemId).put({ ...q.value, done });
}

/** Kein echtes "Löschen" (QuBits sind unveränderlich) — ein Tombstone-Flag, das die Liste beim Anzeigen herausfiltert. */
export async function deleteItem(qu, itemId) {
  const q = await qu.get(itemId);
  if (!q) return;
  return qu.get(itemId).put({ ...q.value, deleted: true });
}

/** Alle (nicht gelöschten) Einträge, älteste zuerst. */
export async function listItems(qu, listId) {
  const rows = await qu.session.query(`${listId}/items/**`);
  return rows.filter((q) => !q.value.deleted).sort((a, b) => a.ts - b.ts);
}

export function onItemsChange(qu, listId, callback) {
  return qu.get(listId).get('items').map(callback);
}
