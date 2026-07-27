// A "calendar" is a plain Space (§8, same as a Chat room/ToDo list/Forum
// board) — every function below takes a `qu` bound to it and is a short
// get/put/set/map recipe on top, same house style as modules/chat.js. This
// module contributes exactly ONE new mechanism the rest of the codebase
// doesn't already have: inviting someone to a SINGLE event without making
// them a member of the calendar Space at all (see inviteToEvent() below) —
// everything else (calendar-space-level membership, encryption, edit
// semantics) is a direct reuse of existing primitives.
//
// Confidentiality (requirement: "ALLE Inhalte sollen verschlüsselt sein")
// needs one important, easy-to-miss detail: a calendar Space keeps
// `readers: ['*']` structural (same reason space-membership.js's
// ensureSpace() does — a relay may only forward what it's itself a reader
// of, see that file's doc comment), which means QuSession's automatic
// default-recipients fallback (core/session.js's #defaultRecipients()) is a
// NO-OP here (it only ever kicks in when `readers` isn't `['*']`). Every
// write in this module therefore computes and passes `encryptFor`
// EXPLICITLY — silently relying on the default would leave every event,
// title, location, and RSVP in PLAINTEXT despite `readers: ['*']` looking
// no different from any other Space.
//
// ACL is whole-Space, not per-path (core/acl.js's createACLPlugin/
// filterForReader both resolve one manifest per Space, never per sub-id) —
// this is the load-bearing fact behind inviteToEvent()'s design: there is
// no way to grant write/read access to just ONE path under a Space without
// granting it Space-wide, so an outsider invited to a single event is NEVER
// added to the calendar's `writers`/`readers`/`admins` (that would make them
// visibly a full member — exactly what a per-event invite is supposed to
// avoid). Reachability instead comes purely from `encryptFor` addressing on
// that one event QuBit, discovered via a ping into a per-event "invite
// inbox" (eventInviteBoxId() below — same IDEA as space-membership.js's
// inboxId(), a well-known, manifestless, anyone-may-write Space per
// recipient, but its OWN id shape: `event-invites/<fp>`, not `inbox-<fp>`.
// This is deliberate, not a style choice: core/pattern.js only ever treats
// `*`/`**` as a WHOLE path segment (`assertValidPattern`'s own doc —
// "never mid-segment, e.g. 'a*b' is rejected"), so a relay-side listener
// that needs to observe every recipient's invites at once (relay.mjs) MUST
// have the fingerprint as its own segment (`event-invites/*/*` — a valid
// pattern) — `inbox-<fp>` bakes the fingerprint into the SAME segment as
// the `inbox-` prefix, which no wildcard can isolate
// (`inbox-*/event-invites/*` silently never matches anything; it is not
// even a rejected pattern, just a literal string "inbox-*" no real id
// equals). Consequence, stated plainly: an outsider who has an event's id
// in hand also trivially knows the calendar Space's id (a literal path
// prefix) and — since `readers: ['*']` — could subscribe to
// `${spaceId}/events/**` and see METADATA (ids, timestamps, verified writer
// fingerprints, opaque ciphertext) of every other event in that calendar,
// even though they can decrypt none of them. Same "readers:['*'], real
// confidentiality only at the content layer" trade-off Chat/ToDo/Forum
// already accept — not something this module can hide without losing
// default relay-forwarding entirely (see space-membership.js's doc comment).

import { spaceIdOf } from '../core/space.js';
import { ensureSpace, notifyMembers, onSpaceInvite, addSpaceMember, removeSpaceMember, createSpaceMembershipPlugin } from './space-membership.js';

/**
 * A per-recipient, manifestless "invite inbox" for exactly ONE event at a
 * time (contrast with space-membership.js's `inbox-<fp>`, which is one
 * shared inbox for every kind of whole-Space invite) — see file doc above
 * for why this needs its own id shape rather than reusing `inboxId()`
 * directly: the fingerprint must be its own path SEGMENT
 * (`event-invites/<fp>`, not `event-invites-<fp>`), so relay.mjs's
 * server-side listener can use a valid whole-segment wildcard
 * (`event-invites/*\/*`) to observe every recipient's invites at once.
 */
function eventInviteBoxId(fingerprint) {
  return `event-invites/${fingerprint}`;
}

/**
 * "YYYY-MM" of the event's own START, not of `new Date()` (contrast with
 * forum-lib.mjs's currentBucket(), whose bucket IS post time — a forum
 * topic has no separate "occurs on" date). Scheduling something next month
 * must file it under NEXT month's bucket, not today's, so `listEvents()`/
 * `onEventsChange()` for that future month actually find it.
 *
 * Includes the full 4-digit YEAR, not just the month — a calendar is used
 * across year boundaries as a matter of course, so "2025-12" and "2026-01"
 * must be (and are) distinct buckets that also sort correctly in that
 * order, not "12"/"01" colliding across different years or sorting
 * back-to-front. `bucketsBetween()` below relies on exactly this when its
 * cursor rolls over a year boundary via `setUTCMonth()`.
 */
export function bucketOf(startMs) {
  return new Date(startMs).toISOString().slice(0, 7);
}

/** Every "YYYY-MM" bucket touched by the closed interval [fromMs, toMs] — month/week/day views all resolve to one or two bucket queries this way, never "all events, for all time". */
function bucketsBetween(fromMs, toMs) {
  const buckets = [];
  const cursor = new Date(fromMs);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(toMs);
  while (cursor.getTime() <= end.getTime()) {
    buckets.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return buckets;
}

/**
 * An event id is a full path (`<calendarSpaceId>/events/<bucket>/<writerFp>-
 * <ts>`, see createEvent()) — used as a single path SEGMENT under `rsvp/`
 * (a Space-relative slot) it would need its "/" characters read literally,
 * not as further nesting. The part after the last "/" is already unique
 * within this one calendar (each event has its own `<writerFp>-<ts>`), same
 * trick as modules/chat.js's reactionKey().
 */
function eventKey(eventId) {
  return String(eventId).split('/').pop();
}

/** Recipients for an event/RSVP write: the event's own (possibly outsider-widened) `attendees` list if set, else every current Space writer — always plus the caller, so a sender can always read back what they just wrote. */
function recipientsFor(spaceWriters, attendees, selfFp) {
  const base = attendees && attendees.length ? attendees : spaceWriters;
  return [...new Set([selfFp, ...base])];
}

async function currentSpaceWriters(qu, spaceId) {
  const manifestQ = await qu.get(spaceId);
  return manifestQ?.value?.writers ?? [];
}

/** A calendar is exactly a Space with the given members as writers — createChatRoom()'s exact recipe (modules/chat.js:208-210), renamed for this module's own vocabulary. */
export function createCalendarSpace(qu, memberFingerprints = [], { readers = ['*'] } = {}) {
  return qu.createSpace({ writers: [qu.fingerprint, ...memberFingerprints], readers });
}

/**
 * Creates one event, `<calendarSpaceId>/events/<bucket>/<writerFp>-<ts>`
 * (collision-safe append, same reasoning as any other multi-writer
 * collection in this codebase — two members scheduling something in the
 * same millisecond can never collide, different fingerprint = different
 * path segment). `attendees`, if given, narrows visibility to exactly that
 * list (plus the creator) — omit it for a normal, whole-calendar-visible
 * event (`attendees` then defaults to the Space's current writers, both in
 * the stored value AND as the `encryptFor` list, so "who can see this" and
 * "who's listed as attending" agree by construction for the common case).
 * `end` is required even for `allDay` (caller should pass end-of-day) so
 * `listEvents()`'s range filter never has to special-case it.
 *
 * No `recurrence` field in v1 (deliberately deferred) — `undefined`/absent
 * already means "single event" to every reader here, so adding one later
 * is additive, not a breaking migration. A pattern-based recurring-series
 * design was considered during this module's design and is a reasonable
 * later extension, but needs its series id as its OWN path segment, not
 * folded into the `<writerFp>-<ts>` leaf — e.g.
 * `<calendarSpaceId>/events/<bucket>/series/<seriesId>/<occurrenceTs>` —
 * because core/pattern.js's `*`/`**` only ever match a WHOLE segment
 * (`assertValidPattern()`'s own doc: "never mid-segment, e.g. 'a*b' is
 * rejected"; relay.mjs's `event-invites/*\/*` hook vs. the rejected-in-
 * practice `inbox-*` + `/event-invites/*` shape is the concrete lesson
 * this module already learned the hard way, see eventInviteBoxId()'s doc
 * comment) — only that segmented shape lets `series/<seriesId>/**` become
 * a valid, useful pattern for "every occurrence of this one series" later.
 */
export async function createEvent(qu, calendarSpaceId, {
  title, description = null, location = null, start, end, allDay = false, attendees,
} = {}) {
  if (start == null || end == null) throw new Error('[Calendar] createEvent() requires both start and end (epoch ms).');
  const spaceWriters = await currentSpaceWriters(qu, calendarSpaceId);
  const finalAttendees = attendees && attendees.length ? [...new Set(attendees)] : spaceWriters;
  const recipients = recipientsFor(spaceWriters, finalAttendees, qu.fingerprint);
  const bucket = bucketOf(start);
  const value = {
    title, description, location, start, end, allDay,
    createdBy: qu.fingerprint,
    attendees: finalAttendees,
    deleted: false,
  };
  return qu.get(calendarSpaceId).get('events').get(bucket).set(value, { encryptFor: recipients });
}

/**
 * Patches an existing event by `put()`-ing the merged value straight onto
 * its own id — ToDo's shared-list model (examples/todo-lib.mjs's
 * setItemDone()), not Chat's `editOf`-as-new-QuBit log (chat.js:44-55): any
 * current Space writer may move/rename/retitle an event any other writer
 * created, matching "gemeinsame Tages- und Zeitplanung" (shared scheduling)
 * more than an immutable message history. Trade-off, deliberately not
 * hidden: there is no attribution safety net — a legitimate co-writer's
 * `put()` here silently replaces the WHOLE value. Mitigate in the UI, not
 * the ACL (which genuinely cannot express anything narrower — see file doc
 * on whole-Space ACL): always show the QuBit's verified `writer`/`ts` as
 * "last changed by …", and keep `createdBy` inside the payload so "created
 * by X, last edited by Y" stays renderable after any number of edits.
 *
 * Recomputes `encryptFor` from the MERGED attendee list every time (not the
 * original event's) — so narrowing/widening `attendees` via a patch (see
 * inviteToEvent()/removeFromEvent() below) actually changes who can decrypt
 * this specific write, not just what the plaintext claims.
 */
export async function updateEvent(qu, eventId, patch) {
  const q = await qu.get(eventId);
  if (!q?.value) throw new Error(`[Calendar] Event "${eventId}" not found or not readable.`);
  const merged = { ...q.value, ...patch };
  const spaceId = spaceIdOf(eventId);
  const spaceWriters = await currentSpaceWriters(qu, spaceId);
  const recipients = recipientsFor(spaceWriters, merged.attendees, qu.fingerprint);
  return qu.get(eventId).put(merged, { encryptFor: recipients });
}

/** Tombstone, not physical removal (QuBits are append-only/immutable, same as every other module here) — `updateEvent()`'s own merge keeps every other field, so a deleted event's metadata is still inspectable/recoverable, just filtered out of listEvents()/onEventsChange() below. */
export async function deleteEvent(qu, eventId) {
  return updateEvent(qu, eventId, { deleted: true });
}

/**
 * All non-deleted events overlapping `[from, to)` (epoch ms), earliest
 * first — spans however many month buckets that range touches (usually one,
 * sometimes two at a boundary), never "every event this calendar has ever
 * had". Omitting `from`/`to` defaults to the single bucket containing "now"
 * (a reasonable default for a first render before a view range is known).
 */
export async function listEvents(qu, calendarSpaceId, { from, to } = {}) {
  const buckets = (from != null && to != null) ? bucketsBetween(from, to) : [bucketOf(Date.now())];
  const rows = (await Promise.all(buckets.map((b) => qu.session.query(`${calendarSpaceId}/events/${b}/**`)))).flat();
  return rows
    .filter((q) => q.value && !q.value.deleted)
    .filter((q) => from == null || to == null || (q.value.start < to && q.value.end > from))
    .sort((a, b) => a.value.start - b.value.start);
}

/** Live subscription to ONE month bucket's events (default: the bucket containing "now") — a UI showing several months (week view near a boundary, month view itself) subscribes to each touched bucket separately, mirroring forum-lib.mjs's onPosts()'s "never the whole board" stance. */
export function onEventsChange(qu, calendarSpaceId, callback, { bucket = bucketOf(Date.now()), ...opts } = {}) {
  return qu.get(calendarSpaceId).get('events').get(bucket).map(callback, opts);
}

/**
 * Invites `outsiderFp` to exactly ONE event, without touching the calendar
 * Space's manifest at all (see file doc: writers/readers are whole-Space,
 * and adding them there would make them a visible full member — the
 * opposite of what a per-event invite is for). Two things happen:
 *   1. The event's own `attendees`/`encryptFor` is widened to include
 *      `outsiderFp` (a normal updateEvent() patch).
 *   2. A ping into their per-event invite inbox (eventInviteBoxId() above —
 *      same IDEA as space-membership.js's notifyMembers()/inboxId(), just a
 *      distinct id shape, see file doc on why) tells their client which
 *      `spaceId`/`eventId` to fetch — the ONLY way an outsider ever learns
 *      these ids, since they're never a Space member and so never see
 *      anything via onSpaceInvite(). A `set()` (collision-safe), not a
 *      `put()` keyed by `eventId` — an id is a full path, and using it as a
 *      single key would misread its own "/" characters as nesting.
 * The outsider can afterwards read/decrypt exactly this event and set an
 * RSVP (via setOutsiderRSVP() below, since they have no write access to the
 * calendar Space itself) but cannot edit or delete it — no ACL exception
 * needed for that, it falls out for free from them never being a writer.
 */
export async function inviteToEvent(qu, eventId, outsiderFp) {
  const q = await qu.get(eventId);
  if (!q?.value) throw new Error(`[Calendar] Event "${eventId}" not found or not readable.`);
  const attendees = [...new Set([...(q.value.attendees ?? []), outsiderFp])];
  await updateEvent(qu, eventId, { attendees });
  const spaceId = spaceIdOf(eventId);
  return qu.get(eventInviteBoxId(outsiderFp)).set({ fromFp: qu.fingerprint, spaceId, eventId });
}

/** The inverse of inviteToEvent() (also usable to drop a Space member from just this one event while leaving them on the calendar) — narrows `attendees`/`encryptFor` going forward; does NOT retroactively re-encrypt past writes of this event (same "history doesn't change" stance as space-membership.js's removeSpaceMember()). */
export async function removeFromEvent(qu, eventId, fp) {
  const q = await qu.get(eventId);
  if (!q?.value) return;
  const attendees = (q.value.attendees ?? []).filter((a) => a !== fp);
  return updateEvent(qu, eventId, { attendees });
}

/** Live subscription to the caller's OWN per-event invites (past and future) — the outsider-side counterpart of onSpaceInvite(), for the inviteToEvent() mechanism above instead of whole-Space invites. Each delivered value is `{ fromFp, spaceId, eventId }`. */
export function onEventInvites(qu, callback, opts) {
  return qu.get(eventInviteBoxId(qu.fingerprint)).map(callback, opts);
}

/**
 * Space-member RSVP: one LWW register per (event, person), same shape as
 * modules/chat.js's reactions (`reactions/<msgKey>/<fp>`) — repeated calls
 * REPLACE the caller's own status, never accumulate. Lives under the
 * calendar Space (`rsvp/<eventKey>/<fp>`) because a Space member always has
 * write access there; encrypted for the same recipients the event itself
 * currently addresses, read straight off the event's live `attendees` list
 * so a narrowed/widened event's RSVPs stay in sync with who can see them.
 */
export async function setRSVP(qu, eventId, status) {
  const spaceId = spaceIdOf(eventId);
  const eventQ = await qu.get(eventId);
  const spaceWriters = await currentSpaceWriters(qu, spaceId);
  const recipients = recipientsFor(spaceWriters, eventQ?.value?.attendees, qu.fingerprint);
  return qu.get(spaceId).get('rsvp').get(eventKey(eventId)).get(qu.fingerprint).put(status, { encryptFor: recipients });
}

/**
 * Outsider RSVP: CANNOT live under the calendar Space — an outsider invited
 * via inviteToEvent() is deliberately never added to `writers` there (see
 * file doc), so any write under the Space would be ACL-rejected. Lives
 * under the outsider's OWN User-Space instead (always writable, no plugin
 * needed — core/identity-acl.js's structural default), keyed by the full
 * `eventId` URL-encoded into one path segment (an id contains "/", which a
 * literal path segment would otherwise misread as nesting — same reasoning
 * as eventKey() above, just needing the FULL id here, not only its last
 * segment, since this slot must stay unique across every calendar/event the
 * outsider was ever invited to, not just one calendar's own namespace).
 * Encrypted for the event's current attendees, same as setRSVP(), so an
 * outsider's RSVP is exactly as confidential as a member's.
 */
export async function setOutsiderRSVP(qu, eventId, status) {
  const eventQ = await qu.get(eventId);
  const attendees = eventQ?.value?.attendees?.length ? eventQ.value.attendees : [qu.fingerprint];
  const recipients = [...new Set([qu.fingerprint, ...attendees])];
  return qu.own.get('event-rsvp').get(encodeURIComponent(eventId)).put(status, { encryptFor: recipients });
}

/**
 * All currently-known RSVPs for one event, `{ fingerprint: status }` —
 * merges the Space-internal source (setRSVP()) with each currently-invited
 * OUTSIDER's own User-Space slot (setOutsiderRSVP()). This asymmetry is a
 * direct, unavoidable consequence of the whole-Space ACL fact this file's
 * doc comment opens with — a caller cannot enumerate "every outsider who
 * ever RSVP'd" without already knowing their fingerprints, which the
 * event's own `attendees` list (read here) already gives us.
 */
export async function getRSVPs(qu, eventId) {
  const spaceId = spaceIdOf(eventId);
  const [rows, eventQ, spaceWriters] = await Promise.all([
    qu.session.query(`${spaceId}/rsvp/${eventKey(eventId)}/**`),
    qu.get(eventId),
    currentSpaceWriters(qu, spaceId),
  ]);
  const result = {};
  for (const q of rows) {
    if (!q.writer || q.value == null) continue;
    result[q.writer] = q.value;
  }
  const writerSet = new Set(spaceWriters);
  const outsiders = (eventQ?.value?.attendees ?? []).filter((fp) => !writerSet.has(fp));
  await Promise.all(outsiders.map(async (fp) => {
    const rsvpQ = await qu.get(`~${fp}/event-rsvp/${encodeURIComponent(eventId)}`);
    if (rsvpQ?.value != null) result[fp] = rsvpQ.value;
  }));
  return result;
}

/** Live subscription to Space-member RSVP changes for one event — does NOT cover outsider RSVPs (see getRSVPs()'s doc comment on why those can't be enumerated/subscribed generically without already knowing which outsiders were invited). */
export function onRSVPChange(qu, eventId, callback, opts) {
  const spaceId = spaceIdOf(eventId);
  return qu.get(spaceId).get('rsvp').get(eventKey(eventId)).map(callback, opts);
}

/**
 * `qu.use(createCalendarPlugin())` — attaches `qu.createEvent()`/etc. sugar
 * bound to this Qu instance, mirroring modules/chat.js's createChatPlugin().
 * Requires createSpacesPlugin() to already be installed (createCalendarSpace()
 * uses `qu.createSpace`). Also composes createSpaceMembershipPlugin() — every
 * calendar app needs `qu.ensureSpace()`/`qu.addSpaceMember()`/etc. for
 * calendar-space-level invites (see file doc's distinction from the new
 * per-event mechanism), same "compose the thing every caller needs anyway"
 * reasoning chat.js applies to createPresencePlugin().
 */
export function createCalendarPlugin() {
  return {
    install(qu) {
      createSpaceMembershipPlugin().install(qu);
      qu.createCalendarSpace = (memberFingerprints, opts) => createCalendarSpace(qu, memberFingerprints, opts);
      qu.createEvent = (calendarSpaceId, opts) => createEvent(qu, calendarSpaceId, opts);
      qu.updateEvent = (eventId, patch) => updateEvent(qu, eventId, patch);
      qu.deleteEvent = (eventId) => deleteEvent(qu, eventId);
      qu.listEvents = (calendarSpaceId, opts) => listEvents(qu, calendarSpaceId, opts);
      qu.onEventsChange = (calendarSpaceId, callback, opts) => onEventsChange(qu, calendarSpaceId, callback, opts);
      qu.inviteToEvent = (eventId, outsiderFp) => inviteToEvent(qu, eventId, outsiderFp);
      qu.removeFromEvent = (eventId, fp) => removeFromEvent(qu, eventId, fp);
      qu.onEventInvites = (callback, opts) => onEventInvites(qu, callback, opts);
      qu.setRSVP = (eventId, status) => setRSVP(qu, eventId, status);
      qu.setOutsiderRSVP = (eventId, status) => setOutsiderRSVP(qu, eventId, status);
      qu.getRSVPs = (eventId) => getRSVPs(qu, eventId);
      qu.onRSVPChange = (eventId, callback, opts) => onRSVPChange(qu, eventId, callback, opts);
    },
  };
}

// Re-exported here so a caller only ever imports from './calendar.js' for
// everything calendar-related, without also needing to know
// space-membership.js exists — same convenience re-export chat.js/todo-lib.mjs
// give their own membership helpers. Behavior is entirely unmodified.
export { ensureSpace as ensureCalendarSpace, addSpaceMember as addCalendarMember, removeSpaceMember as removeCalendarMember, onSpaceInvite as onCalendarInvite, notifyMembers as notifyCalendarMembers };
