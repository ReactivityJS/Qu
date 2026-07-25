// Two small, Space-neutral mechanisms that started out inside
// modules/chat.js (because chat was the first app to need them) but never
// had any actual chat-specific content — no message shape, no text, just
// "who's here" and "who's read up to where" on top of an arbitrary Space.
// Kept separate here so any app built on modules/space-membership.js (a
// ToDo list, a Forum board, a game lobby — not just chat) can use both
// without pulling in chat.js's message-sending machinery. Same "no
// app-specific noun" discipline as space-membership.js's own file doc.

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
 * `qu.use(createPresencePlugin())` — attaches `qu.markRead()`/`qu.setPresence()`/
 * etc. sugar bound to this Qu instance, each just resolving `spaceId` to a
 * node (`qu.get(spaceId)`) and delegating to the function above. Every
 * function above already works standalone given a space node; write-checks
 * (guest rejection) are inherited for free through the node's `put()`,
 * which these functions call into — nothing here duplicates that check.
 */
export function createPresencePlugin() {
  return {
    install(qu) {
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
