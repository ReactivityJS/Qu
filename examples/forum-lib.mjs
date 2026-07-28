// Beispiel 4: Zeit-Sharding für wachsende Collections (README, Grundkonzepte
// Abschnitt 7) — lauffähig statt nur Prosa. Ein Forum-Board ist wie die
// ToDo-Liste (examples/todo-lib.mjs) nichts weiter als ein generischer
// Space; der einzige neue Kniff ist, wie die Topic-IDs aufgebaut sind:
// `<boardId>/posts/<bucket>/<topicId>` statt flach `<boardId>/posts/<topicId>`
// — ein Client abonniert dann nie "alle Topics, für immer", sondern gezielt
// einen Zeit-Bucket. Die Bucket-Granularität (hier: Monat, "YYYY-MM") ist
// eine reine String-Konvention, kein Pfad-Tiefen-Unterschied — ein Board
// mit wenig Traffic könnte genauso gut `currentBucket = () =>
// new Date().getFullYear().toString()` (Jahres-Buckets) verwenden, ohne
// dass sich sonst irgendetwas hier ändern müsste.
//
// Board = Space, NICHT Topic = Space: die Rechteverwaltung (writers/
// readers/admins, Whitepaper §8.3) hängt an genau EINEM Manifest pro
// Board, jedes Topic ist nur ein Eintrag innerhalb dieses einen Space,
// keine eigene Space-Bootstrap-Zeremonie. Ein Nutzer für das ganze Board
// freizuschalten/zu sperren bleibt so eine EINE Manifest-Änderung
// (grantWriteAccess()/revokeWriteAccess() unten) statt einer pro Topic —
// bei potenziell hunderten Topics ein echter Unterschied, nicht nur
// Geschmackssache. Das Zeit-Sharding oben liefert die Skalierung, die ein
// Topic-pro-Space sonst hätte erkaufen müssen, bereits ohne den Umweg.
//
// Ein Topic ist ein Post MIT `title` (der Themen-Eröffner, `createTopic()`
// unten); alles danach sind `addReply()`-Beiträge OHNE eigenen Titel,
// adressiert über die Topic-ID direkt (`<boardId>/topics/<topicId>/
// replies/<replyId>`) — unabhängig davon, in welchem Zeit-Bucket das Topic
// selbst liegt, denn `set()`s Id ist bereits global eindeutig innerhalb
// des Boards.
//
// Nutzerverwaltung (wer darf posten) ist wie bei todo-lib.mjs/src/modules/cms.js
// aus space-app-lib.mjs importiert, nicht hier eigenständig dupliziert.
import { createSpaceApp, getManifest, canWrite, grantWriteAccess, revokeWriteAccess } from './space-app-lib.mjs';

export { canWrite, grantWriteAccess, revokeWriteAccess };
/** Alias für space-app-lib.mjs's getManifest() — hier unter dem in diesem Modul etablierten Namen. */
export const getBoardManifest = getManifest;

/** Erstellt ein neues, leeres Board. Rückgabe: die Space-ID (für den Link). */
export async function createBoard(qu, opts = {}) {
  return createSpaceApp(qu, opts);
}

/** "YYYY-MM" — lexikographisch sortierbar, also gleichzeitig chronologisch sortierbar (kein Datums-Parsing für den Bucket-Index nötig). */
export function currentBucket(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/**
 * Eröffnet ein neues Topic (Titel + Eröffnungsbeitrag) — set(), weil
 * mehrere Personen unabhängig voneinander posten können (kollisionssicher,
 * siehe §7.2). Trägt zusätzlich den Bucket in den Bucket-Index ein
 * (ebenfalls set() — mehrere gleichzeitige "erstes Topic des Monats"-
 * Schreiber kollidieren dadurch strukturell nie); mehrfaches Eintragen
 * desselben Buckets ist bewusst kein Sonderfall, nur beim Lesen
 * (listBuckets()) wird dedupliziert. Rückgabe trägt `.qubit.id` — die
 * VOLLE Id (`<boardId>/posts/<bucket>/<fingerprint>-<ts>`, siehe
 * core/session.js's append()/ingest(), dieselbe `{...result, qubit}`-Form
 * wie modules/chat.js's sendMessage()), nicht nur ein kurzes Suffix.
 * addReply()/listReplies()/onReplies() unten hängen ihre Beiträge direkt
 * UNTER dieser Id ein (`<topicId>/replies/<replyId>`) statt in einem
 * separaten `topics/`-Ast — ein Topic braucht dafür keine eigene, zweite
 * Id-Konvention, seine eigene reicht als Anker für alles, was zu ihm gehört.
 */
export async function createTopic(qu, boardId, { title, text }, { bucket = currentBucket() } = {}) {
  const board = qu.get(boardId);
  await board.get('bucket-index').set({ bucket });
  return board.get('posts').get(bucket).set({ title, text });
}

/** Alle Topics EINES Buckets, älteste zuerst — nie "alle Topics aller Zeit". */
export async function listPosts(qu, boardId, bucket = currentBucket()) {
  const rows = await qu.session.query(`${boardId}/posts/${bucket}/**`);
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Live-Abonnement auf GENAU einen Bucket (Default: der aktuelle) — nie auf das ganze Board. */
export function onPosts(qu, boardId, callback, { bucket = currentBucket(), ...opts } = {}) {
  return qu.get(boardId).get('posts').get(bucket).map(callback, opts);
}

/** Ein neuer Beitrag zu einem bestehenden Topic (`topicId` = createTopic()s `.id`) — set() aus demselben Kollisions-Grund wie createTopic(), kein eigener `title`. */
export async function addReply(qu, topicId, text) {
  return qu.get(topicId).get('replies').set({ text });
}

/** Alle Beiträge EINES Topics, älteste zuerst. */
export async function listReplies(qu, topicId) {
  const rows = await qu.session.query(`${topicId}/replies/**`);
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Live-Abonnement auf die Beiträge EINES Topics. */
export function onReplies(qu, topicId, callback, opts) {
  return qu.get(topicId).get('replies').map(callback, opts);
}

/** Alle bekannten Buckets dieses Boards, chronologisch sortiert (String-Sortierung reicht dank "YYYY-MM"). */
export async function listBuckets(qu, boardId) {
  const rows = await qu.session.query(`${boardId}/bucket-index/**`);
  return [...new Set(rows.map((q) => q.value.bucket))].sort();
}

/** Der nächstältere Bucket vor `bucket` (Default: der aktuelle) — `null`, wenn keiner bekannt ist. Die "Ältere laden"-Grundoperation, ohne Pagination-Primitiv im Core. */
export async function olderBucket(qu, boardId, bucket = currentBucket()) {
  const buckets = await listBuckets(qu, boardId);
  const i = buckets.indexOf(bucket);
  return i > 0 ? buckets[i - 1] : null;
}
