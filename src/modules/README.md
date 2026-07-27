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
   |                 onSpaceInvite() — "how do members find out a Space exists"
   |
   +-- presence.js    "who's here" + read receipts, Space-neutral
   |
   +-- chat.js        Message send/receive + attachments, composes presence.js
   |
   +-- calendar.js    Events (create/update/delete, month-bucketed), Space-level
                      AND per-event invites, RSVP — composes space-membership.js
                      for calendar-space membership; the per-event invite is its
                      own new mechanism (an outsider is never added to the
                      calendar Space itself, see the file's own doc comment).

profiles.js           Identity-centric, independent of the Space layer above:
                      custom profile attributes + an opt-in global directory.

identity-transfer.js  Independent utility: move one identity to a second device.

incognito-identity.js Independent utility: mint additional, unlinked identities
                      (own fingerprint/keypair) a caller can "run as" instead of
                      their main one for a given Space — hides which real user
                      is behind a Space's membership from co-members and casual
                      content inspection, NOT from a relay operator correlating
                      connection metadata (see the file's own doc comment).
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
4. Its own content module (own file, own shape) for whatever it actually
   stores — messages (`chat.js` is exactly this for chat), events
   (`calendar.js`, for a calendar), todos, posts, pages — following the
   same "one plain Space, get/put/set/map on top of it" recipe `chat.js`'s
   own doc comment demonstrates.

`profiles.js`, `identity-transfer.js`, and `incognito-identity.js` sit
outside this chain — they're about the identity itself (attributes,
directory, device transfer, minting an additional one), not about any
particular Space, and are useful to any app regardless of whether it uses
`space-membership.js` at all.

See each file's own header comment for the full reasoning; see
`APP-GUIDE.md` for a walkthrough building an app on `space-app-lib.mjs`,
and API.md's per-module sections for the full function reference.
