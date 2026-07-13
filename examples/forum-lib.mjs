// Beispiel 4: Zeit-Sharding für wachsende Collections (README, Grundkonzepte
// Abschnitt 7) — lauffähig statt nur Prosa. Ein Forum-Board ist wie die
// ToDo-Liste (examples/todo-lib.mjs) nichts weiter als ein generischer
// Space; der einzige neue Kniff ist, wie die Post-IDs aufgebaut sind:
// `<boardId>/posts/<bucket>/<postId>` statt flach `<boardId>/posts/<postId>`
// — ein Client abonniert dann nie "alle Posts, für immer", sondern gezielt
// einen Zeit-Bucket. Die Bucket-Granularität (hier: Monat, "YYYY-MM") ist
// eine reine String-Konvention, kein Pfad-Tiefen-Unterschied — ein Board
// mit wenig Traffic könnte genauso gut `currentBucket = () =>
// new Date().getFullYear().toString()` (Jahres-Buckets) verwenden, ohne
// dass sich sonst irgendetwas hier ändern müsste.

/** Erstellt ein neues, leeres Board. Rückgabe: die Space-ID (für den Link). */
export async function createBoard(qu, opts = {}) {
  const space = qu.createSpace({ writers: [qu.fingerprint], readers: ['*'], ...opts }); // synchron — siehe modules/spaces.js
  await space.ready; // wirklich auf das Manifest warten, bevor die ID weitergegeben wird
  return space.id;
}

/** "YYYY-MM" — lexikographisch sortierbar, also gleichzeitig chronologisch sortierbar (kein Datums-Parsing für den Bucket-Index nötig). */
export function currentBucket(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

/**
 * Ein neuer Post — set(), weil mehrere Personen unabhängig voneinander
 * posten können (kollisionssicher, siehe §7.2). Trägt zusätzlich den
 * Bucket in den Bucket-Index ein (ebenfalls set() — mehrere gleichzeitige
 * "erster Post des Monats"-Schreiber kollidieren dadurch strukturell nie);
 * mehrfaches Eintragen desselben Buckets ist bewusst kein Sonderfall, nur
 * beim Lesen (listBuckets()) wird dedupliziert.
 */
export async function addPost(qu, boardId, text, { bucket = currentBucket() } = {}) {
  const board = qu.get(boardId);
  await board.get('bucket-index').set({ bucket });
  return board.get('posts').get(bucket).set({ text });
}

/** Alle Posts EINES Buckets, älteste zuerst — nie "alle Posts aller Zeit". */
export async function listPosts(qu, boardId, bucket = currentBucket()) {
  const rows = await qu.session.query(`${boardId}/posts/${bucket}/**`);
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Live-Abonnement auf GENAU einen Bucket (Default: der aktuelle) — nie auf das ganze Board. */
export function onPosts(qu, boardId, callback, { bucket = currentBucket(), ...opts } = {}) {
  return qu.get(boardId).get('posts').get(bucket).map(callback, opts);
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
