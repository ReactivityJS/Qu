# `src/modules/` — reusable building blocks for shared-Space apps

Everything here is app-agnostic: no module in this directory contains a
message shape, a UI, or an app-specific noun (room/board/list/page). Each
one factors out a piece of behaviour that `examples/chat` needed first, but
that a ToDo list, a Forum, a CMS, or any other "N fingerprints collaborate
on one Space" app needs equally. If you're building a new shared-Space app,
start here before reimplementing any of this from scratch — see
`examples/space-app-lib.mjs` for how `examples/todo`, `examples/forum`, and
`examples/cms` already do this.

They layer on top of each other:

```
spaces.js            ACL plugin: manifest-aware Spaces (createSpace/createSpaceAt)
   |
space-membership.js  Discovery + membership: ensureSpace(), inbox pings,
   |                 onSpaceInvite() — "how do members find out a Space exists".
   |                 Also exports spaceWriterRecipients() — Space-generic
   |                 "who to notify on a new write", shared by chat.js's and
   |                 calendar.js's own push-rule descriptors (see relay.mjs).
   |
   +-- presence.js        "who's here" + read receipts, Space-neutral
   |
   +-- chat.js        Message send/receive + attachments, composes presence.js.
   |                 Also exports createChatPushRule() — an opt-in descriptor
   |                 for relay.mjs's pushRules extension point, see that
   |                 file's own doc comment; relay.mjs itself never hard-
   |                 codes "msgs" or "Chat".
   |
   +-- calendar.js    Events (create/update/delete, month-bucketed), Space-level
   |                 invites (reuses space-membership.js unmodified) AND
   |                 per-event invites/RSVP (reuses item-invites.js below —
   |                 NOT its own mechanism). Also exports
   |                 createCalendarPushRule(), same reasoning as chat.js's.
   |
   +-- notifications.js    Generic cross-app notification feed, same per-identity
                           inbox as onSpaceInvite() but a separate subtree —
                           "a Forum/Chat/ToDo app tells you something happened"

item-invites.js       The ITEM-level sibling of space-membership.js: invite one
                      fingerprint to exactly one item under a Space, without
                      Space membership at all (own inbox, own relay push-rule
                      descriptor — createItemInvitePushRule()). App-agnostic on
                      purpose: calendar.js's per-event invite uses it, but so
                      could a chat message shared with an outsider, or a ToDo
                      item handed to an external collaborator — this module has
                      no opinion on what "the item" is, same stance
                      space-membership.js takes on "the Space".

profiles.js           Identity-centric, independent of the Space layer above:
                      custom profile attributes + an opt-in global directory.

identity-transfer.js  Independent utility: move one identity to a second device.

incognito-identity.js Independent utility: mint additional, unlinked identities
                      (own fingerprint/keypair) a caller can "run as" instead of
                      their main one for a given Space — hides which real user
                      is behind a Space's membership from co-members and casual
                      content inspection, NOT from a relay operator correlating
                      connection metadata (see the file's own doc comment). Also
                      exports a persisted, encrypted-to-self alias list
                      (saveIncognitoIdentity()/loadIncognitoStore()/
                      removeIncognitoIdentity()/onIncognitoIdentitiesChange()) —
                      one QuBit per alias under the MAIN identity's own Space,
                      so the alias list itself survives a reload and syncs
                      across that identity's own devices, with only the COUNT
                      of aliases ever visible to a relay mirroring it.

contacts.js           Independent utility: a private "people I know" list —
                      distinct from profiles.js's PUBLIC opt-in directory,
                      encrypted-to-self, never visible to anyone but the owner.

devices.js             Independent utility: "which devices does this identity
                      currently use" — listing/labeling only, encrypted-to-self.
                      Deliberately does NOT support per-device revocation (every
                      device holds a verbatim copy of the same keypair today —
                      see the file's own doc comment for why that's a real,
                      intentionally-punted limitation, not an oversight).
```

A new shared-Space app typically needs, bottom-up:

1. **`spaces.js`** — installed once per `Qu` instance (`createSpacesPlugin()`)
   so `qu.createSpace()`/`qu.get(spaceId)` exist at all.
2. **`space-membership.js`** — `ensureSpace(qu, id, members)` to bootstrap a
   Space's manifest, `notifyMembers()`/`onSpaceInvite()` so every member's
   inbox picks up newly-shared Spaces without an out-of-band link.
3. **`presence.js`** (optional) — `markRead()`/`getReadReceipts()` and
   `setPresence()`/`onPresence()` if the app wants "who's here" / "seen"
   UI, without needing chat's message-sending machinery at all.
3b. **`notifications.js`** (optional) — `notifyUser(qu, fp, notification)`/
   `onNotification(qu, cb)` if the app wants to tell a user something
   happened (a reply, a mention, a like) beyond "a Space now exists for
   you" (that's `onSpaceInvite()`'s job, above) — a welcome page/ecosystem
   shell merges both feeds, since they share the same per-identity inbox.
4. Its own content module (own file, own shape) for whatever it actually
   stores — messages (`chat.js` is exactly this for chat), events
   (`calendar.js`, for a calendar), todos, posts, pages — following the
   same "one plain Space, get/put/set/map on top of it" recipe `chat.js`'s
   own doc comment demonstrates.

`profiles.js`, `identity-transfer.js`, `incognito-identity.js`,
`contacts.js`, and `devices.js` sit outside this chain — they're about the
identity itself (attributes, directory, device transfer, minting an
additional one, a private contact list, a private device list), not about
any particular Space, and are useful to any app regardless of whether it uses
`space-membership.js` at all.

See each file's own header comment for the full reasoning; see
`APP-GUIDE.md` for a walkthrough building an app on `space-app-lib.mjs`,
and API.md's per-module sections for the full function reference.
