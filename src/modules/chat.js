// A "chat room" (1:1 or group — no difference in the model, only in who's
// listed as writers/readers on the Space manifest) is a plain Space (§8).
// Every function below takes a `space` node (`qu.get(spaceId)`, see
// core/space-handle.js) and is just a short get/put/set/map recipe on top
// of it — this module contributes no new safety mechanism, only convenient
// naming and attachment handling on top of what Core already guarantees
// (write-checks are inherited for free through QuSpace's put()/set()).

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
 */
export async function sendMessage(space, { text, attachments = [], encryptFor } = {}) {
  const fp = space.session.fingerprint;
  const refs = [];
  for (const att of attachments) {
    const fileId = `files/${fp}/${space.runtime.nextTs()}-${randomId()}`;
    // `encryptFor` durchreichen wie beim Nachrichtentext — sonst würde
    // dieselbe Nachricht am Ende inkonsistent verschlüsselt: Text
    // geschützt, aber Dateiname/MIME-Typ/Größe des Anhangs im Klartext,
    // egal was der Aufrufer für die Nachricht selbst gewählt hat. WICHTIG:
    // das verschlüsselt nur das MANIFEST (Metadaten) — die eigentlichen
    // Datei-BYTES bleiben unverschlüsselt (data/files/manifest.js's
    // publishFile(): Chunks werden inhaltsadressiert über den Klartext-
    // Hash gespeichert, absichtlich, für kostenloses Dedup über mehrere
    // Sender hinweg — Verschlüsselung würde pro Empfänger einen anderen
    // Hash für denselben Inhalt erzeugen und dieses Dedup strukturell
    // zerstören). Ein 1:1-Chat ist heute also für TEXT Ende-zu-Ende
    // verschlüsselbar, für ANHANG-INHALTE (noch) nicht.
    const { manifestId } = await space.get(fileId).put(att.bytes, { name: att.name, mime: att.mime, fileStorage: att.fileStorage, encryptFor });
    refs.push(manifestId);
  }
  return space.get('msgs').set({ text }, { refs: refs.length ? refs : undefined, encryptFor });
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

// --- Read receipts ---
//
// "Read up to ts X" is a single, per-reader mutable fact, not a growing
// collection — the right tool is put() (LWW-Register, §7.2), not set().
// Each reader gets their own fixed slot (`reads/${fingerprint}`); a room's
// writers list already lets every member write anywhere in the room (one
// Space, one manifest, §8), so nothing stops member B from technically
// writing to `.../reads/<alice's fp>` — but exactly as with message ids
// (§7.2), the path is addressing, not trust: the QuBit's verified `writer`
// field is what a UI must key off, never the path segment.

/** Marks everything up to and including `uptoTs` as read by the caller. */
export async function markRead(space, uptoTs) {
  return space.get(`reads/${space.session.fingerprint}`).put({ upTo: uptoTs });
}

/** { [readerFingerprint]: upToTs } — built from each entry's verified `writer`, not its path. */
export async function getReadReceipts(space) {
  const rows = await space.session.query(`${space.id}/reads/**`);
  const receipts = {};
  for (const q of rows) {
    if (!q.writer) continue;
    const existing = receipts[q.writer];
    if (existing === undefined || q.value.upTo > existing) receipts[q.writer] = q.value.upTo;
  }
  return receipts;
}

export function onReadReceipt(space, callback, opts) {
  return space.get('reads').map(callback, opts);
}

// --- Presence ---
//
// Online status is inherently ephemeral and self-correcting — persisting
// it forever would misrepresent a member who vanished without a clean
// disconnect. Modeled as a per-member LWW slot with a heartbeat: a reader
// treats an entry as online only while `lastSeen` is recent, regardless of
// whether an explicit "offline" was ever published (covers both graceful
// leaves and a browser tab simply disappearing).

const DEFAULT_STALE_MS = 20_000;
const DEFAULT_HEARTBEAT_MS = 8_000;

export async function setPresence(space, status) {
  return space.get(`presence/${space.session.fingerprint}`).put({ status, lastSeen: space.runtime.nextTs() });
}

/** { [fingerprint]: { status, lastSeen, online } } — `online` folds in staleness, not just the last published status. */
export async function getPresence(space, { staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const rows = await space.session.query(`${space.id}/presence/**`);
  const now = Date.now();
  const presence = {};
  for (const q of rows) {
    if (!q.writer) continue;
    const isFresh = now - q.value.lastSeen < staleAfterMs;
    presence[q.writer] = { status: q.value.status, lastSeen: q.value.lastSeen, online: isFresh && q.value.status === 'online' };
  }
  return presence;
}

export function onPresenceChange(space, callback, opts) {
  return space.get('presence').map(callback, opts);
}

/**
 * Publishes 'online' every `intervalMs`, and 'offline' once when stopped
 * (best-effort — an ungraceful disconnect, e.g. closing a browser tab,
 * skips this; readers must still treat staleness as the source of truth,
 * not just the last explicit status).
 */
export function startHeartbeat(space, { intervalMs = DEFAULT_HEARTBEAT_MS } = {}) {
  setPresence(space, 'online').catch(() => {});
  const timer = setInterval(() => { setPresence(space, 'online').catch(() => {}); }, intervalMs);
  return async function stop() {
    clearInterval(timer);
    await setPresence(space, 'offline').catch(() => {});
  };
}

/**
 * `qu.use(createChatPlugin())` — attaches `qu.sendMessage()`/`qu.onMessage()`/
 * etc. sugar bound to this Qu instance, each just resolving `spaceId` to a
 * node (`qu.get(spaceId)`) and delegating to the function above. Every
 * function above already works standalone given a space node
 * (`sendMessage(space, opts)`); write-checks (guest rejection) are inherited
 * for free through the node's `put()`/`set()`/`qu.createSpace()`, which
 * these functions call into — nothing here duplicates that check.
 */
export function createChatPlugin() {
  return {
    install(qu) {
      qu.createChatRoom = (memberFingerprints, opts) => createChatRoom(qu, memberFingerprints, opts);
      qu.sendMessage = (spaceId, opts) => sendMessage(qu.get(spaceId), opts);
      qu.listMessages = (spaceId) => listMessages(qu.get(spaceId));
      qu.onMessage = (spaceId, callback, opts) => onMessage(qu.get(spaceId), callback, opts);
      qu.markRead = (spaceId, uptoTs) => markRead(qu.get(spaceId), uptoTs);
      qu.getReadReceipts = (spaceId) => getReadReceipts(qu.get(spaceId));
      qu.onReadReceipt = (spaceId, callback, opts) => onReadReceipt(qu.get(spaceId), callback, opts);
      qu.setPresence = (spaceId, status) => setPresence(qu.get(spaceId), status);
      qu.getPresence = (spaceId, opts) => getPresence(qu.get(spaceId), opts);
      qu.onPresenceChange = (spaceId, callback, opts) => onPresenceChange(qu.get(spaceId), callback, opts);
      qu.startHeartbeat = (spaceId, opts) => startHeartbeat(qu.get(spaceId), opts);
    },
  };
}
