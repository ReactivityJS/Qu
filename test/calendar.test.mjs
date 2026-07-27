import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, createSpacesPlugin, createCalendarPlugin,
  createCalendarSpace, createEvent, updateEvent, deleteEvent, listEvents, onEventsChange,
  inviteToEvent, removeFromEvent, onEventInvites,
  setRSVP, setOutsiderRSVP, getRSVPs, onRSVPChange,
  calendarBucketOf,
} from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

async function makeOwner() {
  return (await Qu.create()).use(createSpacesPlugin()).use(createCalendarPlugin());
}

test('createEvent(): a calendar-space writer can create an event; a non-member cannot', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  const stranger = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, bob].map((qu) => qu.publishProfile()));

  const room = createCalendarSpace(alice, [bob.fingerprint]);
  await room.ready;

  await createEvent(alice, room.id, { title: 'Team Meeting', start: 1000, end: 2000 });
  await createEvent(bob, room.id, { title: 'Bob event', start: 1000, end: 2000 }); // bob is a writer too, must not throw
  await assert.rejects(() => createEvent(stranger, room.id, { title: 'sneaky', start: 1000, end: 2000 }));
});

test('updateEvent(): any calendar-space writer may edit an event another writer created — shared-list semantics, not per-author ownership', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, bob].map((qu) => qu.publishProfile()));
  const room = createCalendarSpace(alice, [bob.fingerprint]);
  await room.ready;

  const { qubit } = await createEvent(alice, room.id, { title: 'Lunch', start: 1000, end: 2000 });
  await updateEvent(bob, qubit.id, { title: 'Lunch (moved)', start: 5000, end: 6000 });

  const updated = await alice.get(qubit.id);
  assert.equal(updated.value.title, 'Lunch (moved)');
  assert.equal(updated.value.start, 5000);
  assert.equal(updated.writer, bob.fingerprint, 'last edit is attributed to bob, the verified writer of this QuBit');
  assert.equal(updated.value.createdBy, alice.fingerprint, 'original creator survives every merge-patch, so "created by X, last edited by Y" stays renderable');
});

test('createEvent(): a narrower `attendees` list keeps the event unreadable for a calendar-space co-member who is not on it', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, bob, carol].map((qu) => qu.publishProfile()));

  const room = createCalendarSpace(alice, [bob.fingerprint, carol.fingerprint]);
  await room.ready;

  const { qubit } = await createEvent(alice, room.id, {
    title: 'Private lunch with Bob', start: 1000, end: 2000, attendees: [alice.fingerprint, bob.fingerprint],
  });

  const bobView = await bob.get(qubit.id);
  assert.equal(bobView.value.title, 'Private lunch with Bob');

  const carolView = await carol.get(qubit.id);
  assert.equal(carolView.value, undefined, 'carol is a calendar-space member but not an addressed recipient of this specific event');
  assert.equal(carolView.encrypted, true);
});

test('inviteToEvent(): an outsider never added to the calendar Space can read/decrypt exactly the one event they were invited to, and nothing else', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime }); // the outsider — never a calendar member
  await Promise.all([alice, bob, carol].map((qu) => qu.publishProfile()));

  const room = createCalendarSpace(alice, [bob.fingerprint]);
  await room.ready;

  const { qubit: ev1 } = await createEvent(alice, room.id, { title: 'Team sync', start: 1000, end: 2000 });
  const { qubit: ev2 } = await createEvent(alice, room.id, { title: 'Another meeting', start: 3000, end: 4000 });

  await inviteToEvent(alice, ev1.id, carol.fingerprint);

  const carolView = await carol.get(ev1.id);
  assert.equal(carolView.value.title, 'Team sync', 'carol can decrypt exactly the event she was invited to');

  const carolOtherView = await carol.get(ev2.id);
  assert.equal(carolOtherView.value, undefined, 'carol cannot decrypt an event she was never invited to');

  const manifest = await carol.get(room.id);
  assert.ok(!manifest.value.writers.includes(carol.fingerprint), 'carol was never added as a calendar-space writer');
  assert.ok(!manifest.value.admins.includes(carol.fingerprint), 'carol was never added as a calendar-space admin');
});

test('inviteToEvent(): the invited outsider still cannot write anything under the calendar Space — no ACL exception is made for them', async () => {
  const alice = await makeOwner();
  const carol = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, carol].map((qu) => qu.publishProfile()));
  const room = createCalendarSpace(alice, []);
  await room.ready;
  const { qubit } = await createEvent(alice, room.id, { title: 'Solo', start: 1000, end: 2000 });
  await inviteToEvent(alice, qubit.id, carol.fingerprint);

  await assert.rejects(() => updateEvent(carol, qubit.id, { title: 'hijacked' }));
  await assert.rejects(() => setRSVP(carol, qubit.id, 'going'), 'an outsider has no write access to rsvp/ under the calendar Space either');
});

test('onEventInvites(): an outsider is notified of a per-event invite via their own inbox, distinct from whole-Space invites', async () => {
  const alice = await makeOwner();
  const carol = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, carol].map((qu) => qu.publishProfile()));
  const room = createCalendarSpace(alice, []);
  await room.ready;
  const { qubit } = await createEvent(alice, room.id, { title: 'Solo event', start: 1000, end: 2000 });

  const received = [];
  onEventInvites(carol, (q) => received.push(q.value));
  await inviteToEvent(alice, qubit.id, carol.fingerprint);
  await wait();

  assert.equal(received.length, 1);
  assert.equal(received[0].fromFp, alice.fingerprint);
  assert.equal(received[0].eventId, qubit.id);
  assert.equal(received[0].spaceId, room.id);
});

test('setOutsiderRSVP()/getRSVPs(): an invited outsider RSVPs under their own User-Space, merged correctly with Space-member RSVPs', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, bob, carol].map((qu) => qu.publishProfile()));

  const room = createCalendarSpace(alice, [bob.fingerprint]);
  await room.ready;
  const { qubit } = await createEvent(alice, room.id, { title: 'Team lunch', start: 1000, end: 2000 });
  await inviteToEvent(alice, qubit.id, carol.fingerprint);

  await setRSVP(bob, qubit.id, 'going');
  await setOutsiderRSVP(carol, qubit.id, 'maybe');

  const rsvps = await getRSVPs(alice, qubit.id);
  assert.equal(rsvps[bob.fingerprint], 'going');
  assert.equal(rsvps[carol.fingerprint], 'maybe');
});

test('setRSVP(): repeated calls from the same person replace the previous status, never accumulate', async () => {
  const alice = await makeOwner();
  const room = createCalendarSpace(alice, []);
  await room.ready;
  const { qubit } = await createEvent(alice, room.id, { title: 'Solo', start: 1000, end: 2000 });

  await setRSVP(alice, qubit.id, 'going');
  assert.deepEqual(await getRSVPs(alice, qubit.id), { [alice.fingerprint]: 'going' });
  await setRSVP(alice, qubit.id, 'declined');
  assert.deepEqual(await getRSVPs(alice, qubit.id), { [alice.fingerprint]: 'declined' });
});

test('onRSVPChange(): live subscription to Space-member RSVP changes for one event', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, bob].map((qu) => qu.publishProfile()));
  const room = createCalendarSpace(alice, [bob.fingerprint]);
  await room.ready;
  const { qubit } = await createEvent(alice, room.id, { title: 'x', start: 1000, end: 2000 });

  const seen = [];
  onRSVPChange(alice, qubit.id, (q) => seen.push(q.writer));
  await setRSVP(bob, qubit.id, 'going');
  await wait();
  assert.deepEqual(seen, [bob.fingerprint]);
});

test('deleteEvent(): tombstones the event (put deleted:true), filtered out of listEvents() but not physically removed', async () => {
  const alice = await makeOwner();
  const room = createCalendarSpace(alice, []);
  await room.ready;
  const { qubit: keep } = await createEvent(alice, room.id, { title: 'Keep', start: 1000, end: 2000 });
  const { qubit: gone } = await createEvent(alice, room.id, { title: 'Delete me', start: 1500, end: 2500 });

  await deleteEvent(alice, gone.id);

  const listed = await listEvents(alice, room.id, { from: 0, to: 10000 });
  assert.deepEqual(listed.map((q) => q.value.title), ['Keep']);
  assert.equal(listed.some((q) => q.id === keep.id), true);

  const raw = await alice.get(gone.id);
  assert.equal(raw.value.deleted, true, 'a tombstoned event is still readable directly, just filtered by listEvents()');
});

test('removeFromEvent(): narrows an event\'s attendees/encryptFor going forward — a removed member can no longer decrypt it', async () => {
  const alice = await makeOwner();
  const bob = await Qu.create({ runtime: alice.runtime });
  await Promise.all([alice, bob].map((qu) => qu.publishProfile()));
  const room = createCalendarSpace(alice, [bob.fingerprint]);
  await room.ready;
  const { qubit } = await createEvent(alice, room.id, { title: 'Both', start: 1000, end: 2000 });

  assert.equal((await bob.get(qubit.id)).value.title, 'Both');
  await removeFromEvent(alice, qubit.id, bob.fingerprint);
  const bobViewAfter = await bob.get(qubit.id);
  assert.equal(bobViewAfter.value, undefined, 'bob is no longer an addressed recipient after being removed from just this event');
});

test('listEvents(): spans multiple month buckets when the requested range crosses a boundary', async () => {
  const alice = await makeOwner();
  const room = createCalendarSpace(alice, []);
  await room.ready;

  const jan15 = Date.UTC(2026, 0, 15);
  const feb15 = Date.UTC(2026, 1, 15);
  await createEvent(alice, room.id, { title: 'January event', start: jan15, end: jan15 + 3600000 });
  await createEvent(alice, room.id, { title: 'February event', start: feb15, end: feb15 + 3600000 });

  const listed = await listEvents(alice, room.id, { from: jan15 - 1000, to: feb15 + 3600000 + 1000 });
  assert.deepEqual(listed.map((q) => q.value.title), ['January event', 'February event'], 'earliest first, across both touched buckets');
});

test('bucketOf()/listEvents(): a calendar spans year boundaries correctly — "YYYY-MM" bakes in the full year, not just the month', async () => {
  const alice = await makeOwner();
  const room = createCalendarSpace(alice, []);
  await room.ready;

  const dec2025 = Date.UTC(2025, 11, 20);
  const jan2026 = Date.UTC(2026, 0, 5);
  assert.equal(calendarBucketOf(dec2025), '2025-12');
  assert.equal(calendarBucketOf(jan2026), '2026-01');
  assert.ok(calendarBucketOf(dec2025) < calendarBucketOf(jan2026), 'buckets must sort chronologically across a year boundary too');

  await createEvent(alice, room.id, { title: 'New Year\'s Eve party', start: dec2025, end: dec2025 + 3600000 });
  await createEvent(alice, room.id, { title: 'New Year\'s Day brunch', start: jan2026, end: jan2026 + 3600000 });

  const listed = await listEvents(alice, room.id, { from: dec2025 - 1000, to: jan2026 + 3600000 + 1000 });
  assert.deepEqual(listed.map((q) => q.value.title), ["New Year's Eve party", "New Year's Day brunch"]);
});

test('onEventsChange(): live subscription to one month bucket only', async () => {
  const alice = await makeOwner();
  const room = createCalendarSpace(alice, []);
  await room.ready;
  const start = Date.UTC(2026, 5, 1);
  const bucket = calendarBucketOf(start);
  const seen = [];
  onEventsChange(alice, room.id, (q) => seen.push(q.value.title), { bucket });

  await createEvent(alice, room.id, { title: 'June event', start, end: start + 1000 });
  await createEvent(alice, room.id, { title: 'July event', start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 6, 1) + 1000 });
  await wait();

  assert.deepEqual(seen, ['June event'], 'only the subscribed bucket delivers, never the whole calendar');
});
