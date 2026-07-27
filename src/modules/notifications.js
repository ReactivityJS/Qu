import { inboxId } from './space-membership.js';

// A generic, cross-app notification feed — layered on
// space-membership.js's per-identity inbox (`inboxId()`, the same physical
// mailbox `onSpaceInvite()` already reads), but a DIFFERENT subtree
// (`notifications/`, next to `requests/`): a generic "you have a new
// notification" is a CONTENT-SHAPE decision, which space-membership.js's
// own file doc explicitly excludes from that module's scope (it only
// bootstraps Spaces and makes them discoverable). This module is where
// that content-shape decision lives instead, so any app on an ecosystem
// built from these modules (a Forum, a Chat, a ToDo list, …) can deliver
// into ONE shared feed a welcome page aggregates, rather than every app
// inventing its own delivery mechanism.
//
// One SET-based collection per recipient (`notifications/<senderFp>-<ts>`),
// deliberately NOT a fixed per-sender slot like `requests/<fromFp>` —
// space-membership's invite-slot model intentionally has "the LATEST
// invite from this sender replaces the previous one" semantics, which is
// exactly wrong here: a generic notification stream (a comment, a like, a
// mention) must never overwrite an earlier, unrelated notification from
// the same app/sender. Growth-wise this is the same class of collection as
// modules/chat.js's messages — an app expecting heavy notification volume
// can layer the same time-sharding pattern (README §7) on top by choosing
// its own `contentRef`/id scheme; this module itself stays a thin,
// unopinionated delivery primitive, not a paginated inbox.

/**
 * Delivers one notification to `fp`'s inbox. `notification` is an
 * arbitrary app-defined payload beyond the documented convention fields
 * below — this module imposes no required shape, it only picks WHERE a
 * notification lives so every app's notifications end up somewhere a
 * shared feed can find them.
 *
 * Documented convention (for interoperable rendering, not enforced here):
 *   appId       — which app this notification is from (e.g. a Service
 *                 Registry id, see server/service-registry.mjs)
 *   kind        — an app-defined short type tag (e.g. 'comment', 'mention')
 *   message     — a short, human-readable summary
 *   contentRef  — where to navigate on click (e.g. `{ appId, spaceId, path }`,
 *                 see APP-GUIDE.md's cross-app content reference convention)
 *
 * `fromFp`/`ts` are always the CALLER's own fingerprint and this write's
 * own timestamp — not caller-suppliable, so a notification can't spoof who
 * it's from (the write is signed as the caller regardless, but this keeps
 * the payload's OWN `fromFp` field trustworthy too, not just the QuBit's
 * `writer`).
 */
export async function notifyUser(qu, fp, notification, opts) {
  return qu.get(inboxId(fp)).get('notifications').set({ ...notification, fromFp: qu.fingerprint }, opts);
}

/**
 * Subscribes to the caller's OWN notification feed —
 * `callback(notification)` fires for every notification ever delivered to
 * this identity, past and future (`.map()`'s `initial: true` default), then
 * live from then on. Each `notification` is the raw QuBit VALUE written by
 * notifyUser() above (`{ ...payload, fromFp }`) — a welcome page merges
 * this with `onSpaceInvite()` (modules/space-membership.js) for one
 * combined feed, since both live in the same per-identity inbox.
 */
export function onNotification(qu, callback, opts) {
  return qu.get(inboxId(qu.fingerprint)).get('notifications').map(callback, opts);
}

/**
 * `qu.use(createNotificationsPlugin())` — attaches `qu.notifyUser()`/
 * `qu.onNotification()` sugar bound to this Qu instance, mirroring every
 * other `create*Plugin()` in this directory. Requires createSpacesPlugin()
 * to already be installed (writes go through the same Spaces-aware ACL
 * resolver as any other Space content, including the recipient's own
 * always-writable inbox — see modules/spaces.js's bootstrap rule).
 */
export function createNotificationsPlugin() {
  return {
    install(qu) {
      qu.notifyUser = (fp, notification, opts) => notifyUser(qu, fp, notification, opts);
      qu.onNotification = (callback, opts) => onNotification(qu, callback, opts);
    },
  };
}
