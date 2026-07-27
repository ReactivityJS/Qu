import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, QuStore, MemoryAdapter, NullAdapter, createNetworkPlugin, createSpacesPlugin, createCalendarPlugin,
  createCalendarPushRule, createItemInvitePushRule,
} from '../src/index.js';
import { createWebSocketChannel } from '../src/network/transports/websocket-browser.js';
import { startTestRelayServer, stopTestRelayServer } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Same harness as test/relay-push.test.mjs — a FAKE sendPush() so this file
 * asserts relay.mjs's own decision logic: "an offline calendar-space member
 * gets pushed at when an event lands" (modules/calendar.js's
 * createCalendarPushRule()) and "an outsider invited to one specific event
 * gets pushed at via their own item-invite inbox" (modules/item-invites.js's
 * createItemInvitePushRule(), generic — not calendar-specific, see that
 * module's doc comment) — without any real network call to a push service.
 * relay.mjs itself knows neither rule; both are opted in explicitly below,
 * exactly as index.js's real deployment does.
 */
function startTestServer(sendPush) {
  const store = new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'push-subscription/', adapter: new NullAdapter(), replicate: false },
  ]);
  return startTestRelayServer({
    store, allowDynamicSubscribe: true, sendPush, pushSubscriptions: new Map(),
    pushRules: [createCalendarPushRule(), createItemInvitePushRule()],
  });
}

async function closeAll(server, ...channels) {
  for (const ch of channels) await ch.close().catch(() => {});
  await stopTestRelayServer(server);
}

/** Exactly what examples/chat/app.mjs's publishPushSubscription() does. */
async function registerPush(qu, repl, subscription) {
  await qu.session.publish(`push-subscription/${qu.fingerprint}`, subscription);
  await repl.sync({ topic: `push-subscription/${qu.fingerprint}` });
}

function makeCalendarPeer() {
  return (Qu.create()).then((qu) => qu.use(createNetworkPlugin()).use(createSpacesPlugin()).use(createCalendarPlugin()));
}

test('an offline calendar-space member with a registered push subscription gets notified when an event is created', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async ({ subscription, payload }) => { pushCalls.push({ subscription, payload }); });

  const alice = await makeCalendarPeer();
  const bob = await makeCalendarPeer();

  const chBRegister = createWebSocketChannel(url);
  const chA = createWebSocketChannel(url);
  try {
    // Bob registers a push subscription and publishes his profile (needed
    // for calendar.js's always-on encryptFor to resolve his ECDH key later),
    // then disconnects entirely — "app closed".
    await chBRegister.connect();
    const replBRegister = await bob.connect(chBRegister, { pushTopics: [''] });
    await bob.publishProfile({ alias: 'Bob' });
    await replBRegister.sync({ topic: bob.userSpaceId });
    const fakeSubscription = { endpoint: 'https://push.example.test/bob-calendar', keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } };
    await registerPush(bob, replBRegister, fakeSubscription);
    replBRegister.close();
    await chBRegister.close();
    await wait(50);

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    await alice.publishProfile({ alias: 'Alice' });
    await replA.sync({ topic: alice.userSpaceId });
    await replA.sync({ topic: bob.userSpaceId }); // pull bob's published epub locally, so alice's encryptFor can resolve it

    const room = alice.createCalendarSpace([bob.fingerprint]);
    await room.ready;
    await wait(30);
    await alice.createEvent(room.id, { title: 'Team sync (secret title)', start: 1000, end: 2000 });
    await wait(150);

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].subscription.endpoint, fakeSubscription.endpoint);
    assert.equal(pushCalls[0].payload.fp, alice.fingerprint);
    assert.match(pushCalls[0].payload.body, /Alice/);
    assert.doesNotMatch(pushCalls[0].payload.body, /Team sync|secret title/, 'the push body must never leak the event title — only a generic template + sender fingerprint');
  } finally {
    await closeAll(server, chBRegister, chA);
  }
});

test('the event\'s own sender never gets self-notified, and an ONLINE member does not get pushed (already receiving it live)', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async (call) => { pushCalls.push(call); });

  const alice = await makeCalendarPeer();
  const bob = await makeCalendarPeer();

  const chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  try {
    await chB.connect();
    const replB = await bob.connect(chB, { pushTopics: [''] });
    await bob.publishProfile({ alias: 'Bob' });
    await replB.sync({ topic: bob.userSpaceId });
    await registerPush(bob, replB, { endpoint: 'https://push.example.test/bob-online', keys: { p256dh: 'x', auth: 'y' } });

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    await alice.publishProfile({ alias: 'Alice' });
    await replA.sync({ topic: alice.userSpaceId });
    await replA.sync({ topic: bob.userSpaceId });

    const room = alice.createCalendarSpace([bob.fingerprint]);
    await room.ready;
    await wait(30);
    await alice.createEvent(room.id, { title: 'bob is online, no push needed', start: 1000, end: 2000 });
    await wait(150);

    assert.equal(pushCalls.length, 0, 'bob is connected live — the relay must not also push at him');
  } finally {
    await closeAll(server, chA, chB);
  }
});

test('inviteToEvent(): an outsider who is never a calendar-space member gets notified via their own inbox, not the calendar\'s member list', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async ({ subscription, payload }) => { pushCalls.push({ subscription, payload }); });

  const alice = await makeCalendarPeer();
  const carol = await makeCalendarPeer(); // the outsider — never added to the calendar Space

  const chCRegister = createWebSocketChannel(url);
  const chA = createWebSocketChannel(url);
  try {
    await chCRegister.connect();
    const replCRegister = await carol.connect(chCRegister, { pushTopics: [''] });
    await carol.publishProfile({ alias: 'Carol' });
    await replCRegister.sync({ topic: carol.userSpaceId });
    const fakeSubscription = { endpoint: 'https://push.example.test/carol-invite', keys: { p256dh: 'x', auth: 'y' } };
    await registerPush(carol, replCRegister, fakeSubscription);
    replCRegister.close();
    await chCRegister.close();
    await wait(50);

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    await alice.publishProfile({ alias: 'Alice' });
    await replA.sync({ topic: alice.userSpaceId });
    await replA.sync({ topic: carol.userSpaceId });

    const room = alice.createCalendarSpace([]);
    await room.ready;
    await wait(30);
    const { qubit } = await alice.createEvent(room.id, { title: 'Solo event', start: 1000, end: 2000 });
    await wait(30);
    await alice.inviteToEvent(qubit.id, carol.fingerprint);
    await wait(150);

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].subscription.endpoint, fakeSubscription.endpoint);
    assert.equal(pushCalls[0].payload.fp, alice.fingerprint);
    // Generic item-invite wording (item-invites.js's createItemInvitePushRule()),
    // NOT calendar-specific — this hook fires for ANY app's inviteToItem(),
    // so it only ever echoes the generic template + whatever `kind` the
    // calling app (here: calendar.js's inviteToEvent()) chose to set.
    assert.match(pushCalls[0].payload.body, /Alice/);
    assert.match(pushCalls[0].payload.body, /Termin/);
  } finally {
    await closeAll(server, chCRegister, chA);
  }
});

test('a calendar-event push subscription is dropped after a 410 Gone from the push service', async () => {
  const sendPush = async () => { const e = new Error('gone'); e.status = 410; throw e; };
  const { server, url, pushSubscriptions } = await startTestServer(sendPush);

  const alice = await makeCalendarPeer();
  const bob = await makeCalendarPeer();

  const chB = createWebSocketChannel(url);
  const chA = createWebSocketChannel(url);
  try {
    await chB.connect();
    const replB = await bob.connect(chB, { pushTopics: [''] });
    await bob.publishProfile({ alias: 'Bob' });
    await replB.sync({ topic: bob.userSpaceId });
    await registerPush(bob, replB, { endpoint: 'https://push.example.test/dead-calendar', keys: { p256dh: 'x', auth: 'y' } });
    replB.close();
    await chB.close();
    await wait(50);

    assert.equal(pushSubscriptions.has(bob.fingerprint), true);

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    await alice.publishProfile({ alias: 'Alice' });
    await replA.sync({ topic: alice.userSpaceId });
    await replA.sync({ topic: bob.userSpaceId });

    const room = alice.createCalendarSpace([bob.fingerprint]);
    await room.ready;
    await wait(30);
    await alice.createEvent(room.id, { title: 'this push will fail with 410', start: 1000, end: 2000 });
    await wait(150);

    assert.equal(pushSubscriptions.has(bob.fingerprint), false);
  } finally {
    await closeAll(server, chB, chA);
  }
});
