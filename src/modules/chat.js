// A "chat room" (1:1 or group — no difference in the model, only in who's
// listed as writers/readers on the Space manifest) is a plain Space (§8).
// Messages use Session/Qu's append(), which is what actually prevents two
// different members from ever colliding on the same message id — this
// module contributes no new safety mechanism, only convenient naming and
// attachment handling on top of what Core already guarantees.

function randomId() {
  return crypto.randomUUID();
}

/**
 * attachments: [{ bytes: Uint8Array, name, mime, fileStorage }]
 * Each attachment is published as its own File-Handling manifest (§11),
 * addressed the same collision-safe way as messages, and referenced from
 * the message QuBit via `refs` — a photo, a video, and an arbitrary file
 * are handled identically; only `mime` differs.
 */
export async function sendMessage(qu, spaceId, { text, attachments = [], encryptFor } = {}) {
  const refs = [];
  for (const att of attachments) {
    const fileId = `${spaceId}/files/${qu.fingerprint}/${qu.runtime.nextTs()}-${randomId()}`;
    const { manifestId } = await qu.shareFile(fileId, att.bytes, {
      name: att.name,
      mime: att.mime,
      fileStorage: att.fileStorage,
    });
    refs.push(manifestId);
  }
  return qu.append(`${spaceId}/msgs`, { text }, { refs: refs.length ? refs : undefined, encryptFor });
}

/** All messages in a room, oldest first. Each still carries its verified `writer` — a UI must display that, never parse authorship out of the id. */
export async function listMessages(qu, spaceId) {
  const rows = await qu.query(`${spaceId}/msgs/**`);
  return rows.slice().sort((a, b) => a.ts - b.ts);
}

/** Live subscription to new messages in a room. */
export function onMessage(qu, spaceId, callback, opts) {
  return qu.on(`${spaceId}/msgs/**`, callback, opts);
}

/** Convenience: a 1:1 or group room is just createSpace() with the right members. */
export async function createChatRoom(qu, memberFingerprints, { readers = memberFingerprints } = {}) {
  return qu.createSpace({ writers: memberFingerprints, readers });
}

// --- Read receipts ---
//
// "Read up to ts X" is a single, per-reader mutable fact, not a growing
// collection — the right tool is publish() (LWW-Register, §7.2), not
// append(). Each reader gets their own fixed slot
// (`${spaceId}/reads/${fingerprint}`); a room's writers list already lets
// every member write anywhere in the room (one Space, one manifest, §8),
// so nothing stops member B from technically writing to
// `.../reads/<alice's fp>` — but exactly as with message ids (§7.2), the
// path is addressing, not trust: the QuBit's verified `writer` field is
// what a UI must key off, never the path segment.

/** Marks everything up to and including `uptoTs` as read by the caller. */
export async function markRead(qu, spaceId, uptoTs) {
  return qu.publish(`${spaceId}/reads/${qu.fingerprint}`, { upTo: uptoTs });
}

/** { [readerFingerprint]: upToTs } — built from each entry's verified `writer`, not its path. */
export async function getReadReceipts(qu, spaceId) {
  const rows = await qu.query(`${spaceId}/reads/**`);
  const receipts = {};
  for (const q of rows) {
    if (!q.writer) continue;
    const existing = receipts[q.writer];
    if (existing === undefined || q.value.upTo > existing) receipts[q.writer] = q.value.upTo;
  }
  return receipts;
}

export function onReadReceipt(qu, spaceId, callback, opts) {
  return qu.on(`${spaceId}/reads/**`, callback, opts);
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

export async function setPresence(qu, spaceId, status) {
  return qu.publish(`${spaceId}/presence/${qu.fingerprint}`, { status, lastSeen: qu.runtime.nextTs() });
}

/** { [fingerprint]: { status, lastSeen, online } } — `online` folds in staleness, not just the last published status. */
export async function getPresence(qu, spaceId, { staleAfterMs = DEFAULT_STALE_MS } = {}) {
  const rows = await qu.query(`${spaceId}/presence/**`);
  const now = Date.now();
  const presence = {};
  for (const q of rows) {
    if (!q.writer) continue;
    const isFresh = now - q.value.lastSeen < staleAfterMs;
    presence[q.writer] = { status: q.value.status, lastSeen: q.value.lastSeen, online: isFresh && q.value.status === 'online' };
  }
  return presence;
}

export function onPresenceChange(qu, spaceId, callback, opts) {
  return qu.on(`${spaceId}/presence/**`, callback, opts);
}

/**
 * Publishes 'online' every `intervalMs`, and 'offline' once when stopped
 * (best-effort — an ungraceful disconnect, e.g. closing a browser tab,
 * skips this; readers must still treat staleness as the source of truth,
 * not just the last explicit status).
 */
export function startHeartbeat(qu, spaceId, { intervalMs = DEFAULT_HEARTBEAT_MS } = {}) {
  setPresence(qu, spaceId, 'online').catch(() => {});
  const timer = setInterval(() => { setPresence(qu, spaceId, 'online').catch(() => {}); }, intervalMs);
  return async function stop() {
    clearInterval(timer);
    await setPresence(qu, spaceId, 'offline').catch(() => {});
  };
}

/**
 * `qu.use(createChatPlugin())` — attaches `qu.sendMessage()`/`qu.onMessage()`/
 * etc. sugar bound to this Qu instance. Every function above already works
 * standalone (`sendMessage(qu, spaceId, opts)`); write-checks (guest
 * rejection) are inherited for free through `qu.append()`/`qu.publish()`/
 * `qu.createSpace()`, which these functions call into — nothing here
 * duplicates that check.
 */
export function createChatPlugin() {
  return {
    install(qu) {
      qu.createChatRoom = (memberFingerprints, opts) => createChatRoom(qu, memberFingerprints, opts);
      qu.sendMessage = (spaceId, opts) => sendMessage(qu, spaceId, opts);
      qu.listMessages = (spaceId) => listMessages(qu, spaceId);
      qu.onMessage = (spaceId, callback, opts) => onMessage(qu, spaceId, callback, opts);
      qu.markRead = (spaceId, uptoTs) => markRead(qu, spaceId, uptoTs);
      qu.getReadReceipts = (spaceId) => getReadReceipts(qu, spaceId);
      qu.onReadReceipt = (spaceId, callback, opts) => onReadReceipt(qu, spaceId, callback, opts);
      qu.setPresence = (spaceId, status) => setPresence(qu, spaceId, status);
      qu.getPresence = (spaceId, opts) => getPresence(qu, spaceId, opts);
      qu.onPresenceChange = (spaceId, callback, opts) => onPresenceChange(qu, spaceId, callback, opts);
      qu.startHeartbeat = (spaceId, opts) => startHeartbeat(qu, spaceId, opts);
    },
  };
}
