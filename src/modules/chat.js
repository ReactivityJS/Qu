// A "chat room" (1:1 or group — no difference in the model, only in who's
// listed as writers/readers on the Space manifest) is a plain Space (§8).
// Every function below takes a `space` node (`qu.get(spaceId)`, see
// core/space-handle.js) and is just a short get/put/set/map recipe on top
// of it — this module contributes no new safety mechanism, only convenient
// naming and attachment handling on top of what Core already guarantees
// (write-checks are inherited for free through QuSpace's put()/set()).
//
// Read receipts and presence used to live here too, but neither has any
// actual chat-specific content (no message shape, no text) — they moved to
// modules/presence.js, which any Space-based app can use on its own.
// createChatPlugin() below still composes createPresencePlugin() so
// existing chat call sites (qu.markRead(), qu.setPresence(), ...) keep
// working unchanged.

import { createPresencePlugin } from './presence.js';

function randomId() {
  return crypto.randomUUID();
}

/**
 * attachments: [{ bytes: Uint8Array, name, mime, fileStorage }]
 * Each attachment is written via put() (auto-detected as a file, chunked
 * into its own manifest — see data/files/index.js), addressed the same
 * collision-safe way as messages, and referenced from the message QuBit via
 * `refs` — a photo, a video, and an arbitrary file are handled identically;
 * only `mime` differs.
 *
 * `onAttachmentProgress`, if given, is called as `(index, progress)` for
 * every `publishFile()` progress tick of `attachments[index]` — see that
 * function's own `onProgress` doc (data/files/manifest.js) for the shape of
 * `progress`. Purely a pass-through so a UI can show upload progress for
 * a large attachment (e.g. a video) instead of an unexplained pause; has
 * no effect on what gets written or how.
 *
 * `replyTo`, if given, is stored as-is inside the message value (e.g.
 * `{ id, writer, ts, text }` — a UI-chosen snapshot of the quoted message,
 * not just its id) — this module has no opinion on its shape, it only
 * carries it through. A snapshot instead of a bare id lets a UI render the
 * quote (author/time/snippet) without an extra lookup, and keeps it
 * displayable even if the original message is later deleted locally on
 * this device.
 *
 * `editOf`, if given, marks this QuBit as an EDIT of an earlier message
 * (its id) rather than a new standalone message — deliberately a separate
 * new QuBit, not an overwrite of the original one's own put()/set() slot.
 * Every writer listed on a room Space can technically write to ANY path in
 * it (§8, "path is addressing, not trust") — overwriting the original's own
 * slot would let ANY member clobber ANY other member's message. A UI must
 * therefore only treat an edit as valid when its verified `writer` matches
 * the ORIGINAL message's verified `writer` (exactly the same principle
 * space-membership.js/chat.js already apply everywhere else); an edit from
 * anyone else is just an ignorable, harmless extra QuBit. Not meant to be
 * combined with `attachments`/`replyTo` — an edit only ever carries `text`.
 *
 * `forwardedFrom`, if given, is a snapshot (`{ writer, ts, text }`, same
 * shape/reasoning as `replyTo`) of a message forwarded from ANOTHER room —
 * `text` here is the forwarding user's own OPTIONAL comment, not the
 * forwarded content itself, so unlike a normal message this may legitimately
 * be sent with an empty `text` (a bare forward, no added comment).
 */
export async function sendMessage(space, { text, attachments = [], encryptFor, onAttachmentProgress, replyTo, editOf, forwardedFrom } = {}) {
  const fp = space.session.fingerprint;
  const refs = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const fileId = `files/${fp}/${space.runtime.nextTs()}-${randomId()}`;
    // `encryptFor` durchreichen wie beim Nachrichtentext — sonst würde
    // dieselbe Nachricht am Ende inkonsistent verschlüsselt: Text
    // geschützt, aber Dateiname/MIME-Typ/Größe/INHALT des Anhangs im
    // Klartext, egal was der Aufrufer für die Nachricht selbst gewählt hat.
    // data/files/manifest.js's publishFile() verschlüsselt bei gesetztem
    // encryptFor sowohl die Datei-BYTES (contentEncryption) als auch
    // Name/Typ/Größe (metaEncryption) — ein 1:1-Chat ist damit für Text
    // UND Anhänge Ende-zu-Ende verschlüsselbar. Trade-off: verschlüsselte
    // Anhänge nutzen pro Upload einen frischen Schlüssel, wodurch das
    // sonst kostenlose Dedup über mehrere Sender hinweg (identische Bytes
    // → identischer Klartext-Hash) für sie entfällt.
    const { manifestId } = await space.get(fileId).put(att.bytes, {
      name: att.name, mime: att.mime, fileStorage: att.fileStorage, encryptFor,
      onProgress: onAttachmentProgress ? (p) => onAttachmentProgress(i, p) : undefined,
    });
    refs.push(manifestId);
  }
  const result = await space.get('msgs').set({ text, replyTo, editOf, forwardedFrom }, { refs: refs.length ? refs : undefined, encryptFor });
  return { ...result, refs };
}

/** All messages in a room, oldest first. Each still carries its verified `writer` — a UI must display that, never parse authorship out of the id. */
export async function listMessages(space) {
  const rows = await space.session.query(`${space.id}/msgs/**`);
  return rows.slice().sort((a, b) => a.ts - b.ts);
}

/** Live subscription to new messages in a room. */
export function onMessage(space, callback, opts) {
  return space.get('msgs').map(callback, opts);
}

// --- Emoji-Reaktionen ---
//
// Eine Reaktion ist EIN LWW-Register pro (Nachricht, Person) — genau wie
// ein Lesebestätigung-Slot (`reads/<fp>`) oder ein Presence-Slot
// (`presence/<fp>`): die neueste `put()` gewinnt, ein erneutes Reagieren
// mit einem anderen Emoji ERSETZT die alte Reaktion derselben Person statt
// eine zweite hinzuzufügen (dieselbe "eine Reaktion pro Person"-Regel wie
// WhatsApp/Matrix/…), `null` entfernt sie wieder (Tombstone, wie überall
// sonst in diesem Codebase).

/**
 * Ein Nachrichten-`id` ist ein VOLLER Pfad (`<roomId>/msgs/<writerFp>-<ts>`,
 * s. sendMessage() oben) — als EIN Pfadsegment unter `reactions/` benutzt,
 * würde `.get()` die enthaltenen "/" fälschlich als weitere verschachtelte
 * Ebenen lesen. Der Teil NACH dem letzten "/" ist innerhalb DIESES Raums
 * bereits eindeutig (jede Nachricht hat ihre eigene `<writerFp>-<ts>`-
 * Kennung) und enthält selbst kein "/" — genau das eine Segment, das
 * `.get()` hier braucht.
 */
function reactionKey(messageId) {
  return String(messageId).split('/').pop();
}

// --- Anheften (Pins) ---
//
// Genau wie eine Reaktion ist ein Pin EIN LWW-Register — hier pro NACHRICHT
// (nicht pro Person): `pins/<msgKey>` ist entweder gesetzt (angeheftet) oder
// per Tombstone (`put(null)`) wieder gelöst. Jedes Mitglied kann jede
// Nachricht anheften/lösen (dieselbe "jeder Schreiber darf jeden Pfad im
// Space schreiben"-Regel wie überall sonst, §8) — wer es zuletzt getan hat,
// steht als verifiziertes `writer`/`ts` am QuBit selbst, nicht im Wert.
// Mehrere gleichzeitig angeheftete Nachrichten sind dadurch von selbst
// unterstützt (jede hat ihren eigenen Slot) — anders als bei Reaktionen gibt
// es hier keinen Grund für ein Limit auf eine Person, da eine Nachricht
// entweder an- oder abgeheftet ist, unabhängig davon, WER das zuletzt tat.

/** Heftet eine Nachricht an (oder erneuert den Pin, falls schon angeheftet). */
export async function pinMessage(space, messageId) {
  return space.get('pins').get(reactionKey(messageId)).put(true);
}

/** Löst den Pin einer Nachricht wieder (Tombstone `put(null)`). */
export async function unpinMessage(space, messageId) {
  return space.get('pins').get(reactionKey(messageId)).put(null);
}

/**
 * Alle aktuell angehefteten Nachrichten dieses Raums, neueste zuerst
 * (Element-Konvention) — jeweils `{ messageId, pinnedBy, pinnedAt }`.
 * `messageId` wird aus dem Pin-Pfad + `space.id` rekonstruiert (derselbe
 * `<roomId>/msgs/<writerFp>-<ts>`-Aufbau, den sendMessage()/append() für
 * JEDE Nachricht dieses Raums erzeugen — s. core/session.js's append()),
 * eine Nachrichten-Payload liefert diese Funktion bewusst NICHT mit (dafür
 * dient bereits listMessages()/die lokale Nachrichtenliste einer UI).
 */
export async function getPinnedMessages(space) {
  const rows = await space.session.query(`${space.id}/pins/**`);
  return rows
    .filter((q) => q.writer && q.value === true)
    .map((q) => ({
      messageId: `${space.id}/msgs/${String(q.id).split('/').pop()}`,
      pinnedBy: q.writer,
      pinnedAt: q.ts,
    }))
    .sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/** Live-Abo auf JEDE Pin-Änderung im Raum (an- wie abheften). */
export function onPinsChange(space, callback, opts) {
  return space.get('pins').map(callback, opts);
}

/** Setzt (oder ersetzt) die EIGENE Reaktion auf eine Nachricht — ein erneuter Aufruf mit einem anderen Emoji tauscht die vorherige einfach aus. */
export async function setReaction(space, messageId, emoji) {
  return space.get('reactions').get(reactionKey(messageId)).get(space.session.fingerprint).put(emoji);
}

/** Entfernt die eigene Reaktion wieder (Tombstone `put(null)`). */
export async function clearReaction(space, messageId) {
  return space.get('reactions').get(reactionKey(messageId)).get(space.session.fingerprint).put(null);
}

/** Alle aktuellen Reaktionen EINER Nachricht als `{ emoji: [fingerprint, …] }` — gefiltert auf das verifizierte `writer`-Feld, nicht den Pfad (dieselbe Regel wie überall sonst in diesem Codebase). */
export async function getReactions(space, messageId) {
  const rows = await space.session.query(`${space.id}/reactions/${reactionKey(messageId)}/**`);
  const byEmoji = {};
  for (const q of rows) {
    if (!q.writer || q.value === null || q.value === undefined) continue;
    (byEmoji[q.value] ??= []).push(q.writer);
  }
  return byEmoji;
}

/** Live-Abo auf JEDE Reaktionsänderung im Raum (alle Nachrichten, alle Personen) — `{ deep: true }`, da `reactions/<msgKey>/<fp>` zwei Ebenen tief liegt, nicht nur eine wie `msgs/*`. */
export function onReactionsChange(space, callback, opts) {
  return space.get('reactions').map(callback, { deep: true, ...opts });
}

/**
 * Convenience: a 1:1 or group room is just createSpace() with the right
 * members. Deliberately NOT `async` — `qu.createSpace()` is itself
 * synchronous (see modules/spaces.js), and wrapping it in an async function
 * would silently unwrap the returned node down to its manifest QuBit (any
 * Promise that resolves WITH a thenable gets chased by the Promise spec —
 * QuSpace is thenable). `qu.createSpace()` throws synchronously for guests,
 * so this does too — no behavior lost by staying synchronous.
 */
export function createChatRoom(qu, memberFingerprints, { readers = memberFingerprints } = {}) {
  return qu.createSpace({ writers: memberFingerprints, readers });
}

/**
 * `qu.use(createChatPlugin())` — attaches `qu.sendMessage()`/`qu.onMessage()`/
 * etc. sugar bound to this Qu instance, each just resolving `spaceId` to a
 * node (`qu.get(spaceId)`) and delegating to the function above. Every
 * function above already works standalone given a space node
 * (`sendMessage(space, opts)`); write-checks (guest rejection) are inherited
 * for free through the node's `put()`/`set()`/`qu.createSpace()`, which
 * these functions call into — nothing here duplicates that check.
 *
 * Also composes createPresencePlugin() — read receipts/presence are used by
 * essentially every chat UI, so `.use(createChatPlugin())` alone is still
 * enough to get `qu.markRead()`/`qu.setPresence()`/etc.; an app that wants
 * ONLY presence without the message-sending half can `.use(createPresencePlugin())`
 * on its own instead (see modules/presence.js).
 */
export function createChatPlugin() {
  return {
    install(qu) {
      createPresencePlugin().install(qu);
      qu.createChatRoom = (memberFingerprints, opts) => createChatRoom(qu, memberFingerprints, opts);
      qu.sendMessage = (spaceId, opts) => sendMessage(qu.get(spaceId), opts);
      qu.listMessages = (spaceId) => listMessages(qu.get(spaceId));
      qu.onMessage = (spaceId, callback, opts) => onMessage(qu.get(spaceId), callback, opts);
      qu.setReaction = (spaceId, messageId, emoji) => setReaction(qu.get(spaceId), messageId, emoji);
      qu.clearReaction = (spaceId, messageId) => clearReaction(qu.get(spaceId), messageId);
      qu.getReactions = (spaceId, messageId) => getReactions(qu.get(spaceId), messageId);
      qu.onReactionsChange = (spaceId, callback, opts) => onReactionsChange(qu.get(spaceId), callback, opts);
      qu.pinMessage = (spaceId, messageId) => pinMessage(qu.get(spaceId), messageId);
      qu.unpinMessage = (spaceId, messageId) => unpinMessage(qu.get(spaceId), messageId);
      qu.getPinnedMessages = (spaceId) => getPinnedMessages(qu.get(spaceId));
      qu.onPinsChange = (spaceId, callback, opts) => onPinsChange(qu.get(spaceId), callback, opts);
    },
  };
}
