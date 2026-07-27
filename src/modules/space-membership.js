// The pattern shared by every multi-writer, multi-member Space this
// codebase builds on top of modules/spaces.js: a chat room in
// examples/chat, but equally a shared list in a ToDo app, a board in a
// Forum, a page in a CMS — "N fingerprints collaborate on one Space, and
// every member should discover it automatically, without first exchanging
// a link." This module factors that discovery/membership layer out of
// examples/chat/app.mjs so any app built the same way (todo, forum, CMS —
// see the module doc for createSpacesPlugin()) can reuse it instead of
// reimplementing inbox pings and manifest bootstrap from scratch.
//
// Deliberately kept neutral to "Space" throughout — no app-specific noun
// (room, list, board, page) appears anywhere in this file, so it applies
// unchanged to any of them.
//
// Deliberately NOT included here (stays app-specific, see examples/chat/
// app.mjs): local persistence of "which spaces do I know about"
// (localStorage, IndexedDB, whatever the app uses), rendering, and any
// content-shape decisions (messages, todos, pages) — this module only
// gets a Space bootstrapped, its membership discoverable, and its members
// notified. Presence/read-receipts live in modules/presence.js, a
// separate Space-neutral module for the same reason this one is — neither
// is membership/discovery-specific, so neither belongs here.

import { spaceIdOf } from '../core/space.js';

/**
 * Every member's own "letterbox" — a manifestless Space (see below) that
 * anyone may write to, used so a Space someone else created for you
 * becomes known locally without you first having to look for it. One per
 * fingerprint, addressed deterministically so no directory/registry is
 * needed to find it.
 */
export function inboxId(fingerprint) {
  return `inbox-${fingerprint}`;
}

/**
 * Ensures the Space at `id` has a manifest granting exactly `members`
 * (plus the caller) write/admin access, creating it if missing. A no-op if
 * a manifest already exists — this bootstraps a Space exactly once,
 * whoever gets there first (same first-write-wins race as
 * modules/spaces.js's createSpaceAt(), accepted for the same reason).
 *
 * `readers: ['*']` is structural, not a privacy choice: a relay may only
 * forward a QuBit it is itself listed as a reader of (core/acl.js's
 * filterForReader()) — a restricted `readers` would block real transport,
 * not just visibility. Actual confidentiality comes from `encryptFor` at
 * the content layer (see modules/chat.js's sendMessage()), same as
 * Signal's server-sees-ciphertext model. Pass `readers` to override for a
 * Space that doesn't need relay-forwarding (or wants its content itself
 * unencrypted-but-access-restricted).
 */
export async function ensureSpace(qu, id, members, { readers = ['*'] } = {}) {
  const manifest = await qu.get(id);
  if (manifest) return qu.get(id);
  const allMembers = [...new Set([qu.fingerprint, ...members])].sort();
  const space = qu.createSpaceAt(id, { writers: allMembers, readers, admins: allMembers });
  await space.ready.catch((e) => console.error(`[SpaceMembership] ensureSpace(): manifest write for ${id} failed:`, e));
  return space;
}

/**
 * Pings every member's inbox (see inboxId() above) so a Space becomes
 * discoverable to them, whether they're seeing it for the first time or
 * this is a membership change they need to catch up on. `.get(fromFp)` as
 * a fixed key: a repeat ping overwrites the previous one instead of
 * growing an unbounded list. `meta` is an arbitrary app-defined payload
 * (e.g. a chat room's `{ alias, name }`) carried alongside the addressing
 * fields — this module has no opinion on its shape.
 *
 * Each member gets sent their OWN view of `members` (everyone except
 * themselves) via a per-recipient list, so their onSpaceInvite() handler
 * can bootstrap the same membership list locally without a round-trip.
 */
export async function notifyMembers(qu, id, members, meta = {}) {
  await Promise.all(members.map((memberFp) => {
    const membersForThem = [qu.fingerprint, ...members].filter((fp) => fp !== memberFp);
    return qu.get(inboxId(memberFp)).get('requests').get(qu.fingerprint).put({
      fromFp: qu.fingerprint, id, members: membersForThem, ...meta,
    }).catch((e) => console.error('[SpaceMembership] notifyMembers(): inbox ping failed:', memberFp, e));
  }));
}

/**
 * Subscribes to the caller's OWN inbox — `callback(request)` fires for
 * every Space someone else invited the caller into, past and future
 * (`.map()`'s `initial: true` default, see core/space-handle.js). Each
 * `request` is the raw QuBit value written by notifyMembers() above:
 * `{ fromFp, id, members, ...meta }`.
 */
export function onSpaceInvite(qu, callback, opts) {
  return qu.get(inboxId(qu.fingerprint)).get('requests').map(callback, opts);
}

/**
 * Adds `newFp` to an existing Space's writers/admins (readers stays as the
 * Space was bootstrapped with — see ensureSpace()) and notifies every
 * member (including the new one) so it's discoverable. Returns the updated
 * member list (`[...members, newFp]`) for the caller to persist — this
 * module holds no membership state of its own, see file doc above. A
 * no-op (returns `members` unchanged) if `newFp` is already a member or is
 * the caller.
 */
export async function addSpaceMember(qu, id, members, newFp, meta = {}) {
  if (members.includes(newFp) || newFp === qu.fingerprint) return members;
  await qu.addToRole(id, 'writers', newFp);
  await qu.addToRole(id, 'admins', newFp);
  const updatedMembers = [...members, newFp];
  await notifyMembers(qu, id, updatedMembers, meta);
  return updatedMembers;
}

/**
 * Removes `fp` from an existing Space's writers/admins. Does NOT retro-
 * actively affect anything already written (same "history doesn't change"
 * stance as removeFromRole() itself) — an app using `encryptFor` per-write
 * (see modules/chat.js's sendMessage()) must additionally stop addressing
 * `fp` on future writes; this function only revokes Space write access.
 * Returns the updated member list for the caller to persist.
 */
export async function removeSpaceMember(qu, id, members, fp) {
  if (!members.includes(fp)) return members;
  await qu.removeFromRole(id, 'writers', fp);
  await qu.removeFromRole(id, 'admins', fp);
  return members.filter((m) => m !== fp);
}

/**
 * Every current writer of the Space `q` was written under (except the
 * structural `'*'` entry, which is never a real, pushable fingerprint) —
 * the recipient set almost every "notify Space members on a new write"
 * push rule needs, regardless of content shape (a chat message, a calendar
 * event, a future app's own collection). Pulled out here, rather than
 * duplicated inside each content module's own push-rule descriptor (see
 * modules/chat.js's createChatPushRule()/modules/calendar.js's
 * createCalendarPushRule()), because it's genuinely Space-generic, not
 * content-specific — the same "membership" concept this whole file is
 * already about, just read for a different purpose (push routing instead
 * of ACL). Takes `runtime` directly (not a `qu`/`Qu` instance) because
 * relay.mjs's push-rule loop only ever has a raw `QuRuntime` to call this
 * with — see that file's `pushRules` doc comment.
 */
export async function spaceWriterRecipients(q, runtime) {
  const manifestQ = await runtime.get(spaceIdOf(q.id));
  return (manifestQ?.value?.writers ?? []).filter((fp) => fp !== '*');
}

/**
 * `qu.use(createSpaceMembershipPlugin())` — attaches `qu.ensureSpace()`/
 * `qu.notifyMembers()`/etc. sugar bound to this Qu instance, mirroring
 * modules/spaces.js's createSpacesPlugin() and modules/chat.js's
 * createChatPlugin(). Requires createSpacesPlugin() to already be
 * installed (uses `qu.createSpaceAt`/`qu.addToRole`/`qu.removeFromRole`).
 */
export function createSpaceMembershipPlugin() {
  return {
    install(qu) {
      qu.ensureSpace = (id, members, opts) => ensureSpace(qu, id, members, opts);
      qu.notifyMembers = (id, members, meta) => notifyMembers(qu, id, members, meta);
      qu.onSpaceInvite = (callback, opts) => onSpaceInvite(qu, callback, opts);
      qu.addSpaceMember = (id, members, newFp, meta) => addSpaceMember(qu, id, members, newFp, meta);
      qu.removeSpaceMember = (id, members, fp) => removeSpaceMember(qu, id, members, fp);
    },
  };
}
