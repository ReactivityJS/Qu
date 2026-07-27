// The item-level sibling of space-membership.js's whole-Space invite
// (ensureSpace()/notifyMembers()/onSpaceInvite()) — "invite one fingerprint
// to exactly ONE item under a Space, without adding them to that Space's
// writers/readers/admins at all." App-agnostic on purpose: a calendar event
// (modules/calendar.js's inviteToEvent()), a single chat message someone
// wants to forward-share with an outsider, one ToDo item handed to an
// external collaborator, one Forum reply — any content module's own
// single-item id works here unchanged. This module has no opinion on what
// "the item" is, exactly like space-membership.js has no opinion on what
// "the Space" is used for.
//
// Why this is its OWN mechanism, not a reuse of space-membership.js's
// `inbox-<fp>` shape: core/pattern.js's `*`/`**` only ever match a WHOLE
// path segment (assertValidPattern()'s own doc — "never mid-segment, e.g.
// 'a*b' is rejected"). A relay-side push rule (see createItemInvitePushRule()
// below) that needs to observe every recipient's item-invites at once
// therefore needs the fingerprint as its own segment
// (`item-invites/<fp>/<inviterFp>-<ts>`) — `inbox-<fp>` bakes the
// fingerprint into the SAME segment as the `inbox-` prefix, which no
// wildcard can isolate (`inbox-*/...` is not even a rejected pattern, it's
// a literal string "inbox-*" no real id ever equals, so such a hook would
// silently never fire — a real, concretely-encountered bug during this
// module's own design, not a theoretical concern).
//
// The invited recipient can afterwards read/decrypt exactly the one item
// they were addressed on (via that item's own `encryptFor`, set by the
// calling content module — this module carries no encryption of its own)
// and, if the content module supports it, respond under their own
// User-Space (since they have no write access to the Space the item lives
// in — see modules/calendar.js's setOutsiderRSVP() for a worked example).

import { spaceIdOf } from '../core/space.js';

/** Every recipient's own "item-invite inbox" — a manifestless, anyone-may-write Space (same bootstrap-race trade-off as space-membership.js's inboxId(), see that file's doc comment), one per fingerprint, addressed deterministically so no directory/registry is needed to find it. */
export function itemInviteBoxId(fingerprint) {
  return `item-invites/${fingerprint}`;
}

/**
 * Invites `recipientFp` to exactly `itemId`, without touching that item's
 * Space manifest at all — the calling content module is responsible for
 * actually widening that item's own `encryptFor` list (this module has no
 * opinion on encryption, see file doc); this function only handles
 * discovery (how the recipient ever learns `itemId` exists). `meta` is an
 * arbitrary, app-defined payload carried alongside the addressing fields
 * (e.g. `{ kind: 'Termin' }` so a generic push rule can mention what kind
 * of thing this is without this module — or relay.mjs — needing to know
 * "Termin" means anything) — this module has no opinion on its shape, same
 * as space-membership.js's `notifyMembers()`.
 */
export async function inviteToItem(qu, itemId, recipientFp, meta = {}) {
  return qu.get(itemInviteBoxId(recipientFp)).set({ fromFp: qu.fingerprint, itemId, ...meta });
}

/** Live subscription to the caller's OWN item-invites (past and future) — the item-level counterpart of space-membership.js's onSpaceInvite(). Each delivered value is `{ fromFp, itemId, ...meta }`. */
export function onItemInvite(qu, callback, opts) {
  return qu.get(itemInviteBoxId(qu.fingerprint)).map(callback, opts);
}

/**
 * `qu.use(createItemInvitesPlugin())` — attaches `qu.inviteToItem()`/
 * `qu.onItemInvite()` sugar, mirroring space-membership.js's
 * createSpaceMembershipPlugin(). No precondition on createSpacesPlugin()
 * (unlike that module) — item-invites never call `qu.createSpace`/
 * `qu.addToRole`, they only ever `get()`/`set()`/`map()` a fixed,
 * manifestless id.
 */
export function createItemInvitesPlugin() {
  return {
    install(qu) {
      qu.inviteToItem = (itemId, recipientFp, meta) => inviteToItem(qu, itemId, recipientFp, meta);
      qu.onItemInvite = (callback, opts) => onItemInvite(qu, callback, opts);
    },
  };
}

/**
 * A reusable, fully app-agnostic push-rule descriptor for relay.mjs's
 * `pushRules` extension point (see that file's doc comment) — works for
 * ANY content module's item invites, not just Calendar's, since it reads
 * nothing but the generic shape `inviteToItem()` itself already produces.
 * `resolveRecipients` picks the recipient straight out of the id's own
 * second segment (`item-invites/<fp>/...`) — no manifest lookup needed,
 * unlike a "notify this Space's writers" rule (see
 * space-membership.js's spaceWriterRecipients()). `buildPayload` stays
 * generic ("etwas wurde geteilt") but optionally echoes whatever `kind` the
 * inviting app chose to set in its own `meta` (see inviteToItem()'s doc) —
 * this reads a caller-supplied STRING VALUE, not a hardcoded app name, so
 * relay.mjs itself never needs to know "Termin"/"Kalender"/any app exists.
 */
export function createItemInvitePushRule() {
  return {
    pattern: `${itemInviteBoxId('*')}/*`,
    resolveRecipients: (q) => {
      const toFp = q.id.split('/')[1];
      return toFp ? [toFp] : [];
    },
    buildPayload: (q, senderName) => {
      const kind = typeof q.value?.kind === 'string' && q.value.kind ? ` (${q.value.kind})` : '';
      return {
        title: 'QU',
        body: senderName ? `${senderName} hat dir etwas geteilt${kind}` : `Etwas wurde mit dir geteilt${kind}.`,
      };
    },
  };
}

// spaceIdOf is re-exported here for callers that only import this module
// and need to turn an itemId back into its owning Space id (e.g. to check
// membership/manifest state) without a second import from core/space.js.
export { spaceIdOf };
