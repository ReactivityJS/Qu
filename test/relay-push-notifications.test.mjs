import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, QuStore, MemoryAdapter, NullAdapter, createNetworkPlugin, createSpacesPlugin, createNotificationsPlugin, createNotificationPushRule } from '../src/index.js';
import { createWebSocketChannel } from '../src/network/transports/websocket-browser.js';
import { startTestRelayServer, stopTestRelayServer } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Same wiring/shape as test/relay-push.test.mjs's own suite (chat's push
 * rule) — this file is the equivalent coverage for
 * modules/notifications.js's createNotificationPushRule(), the generic
 * "any app can push-enable a notification just by calling
 * qu.notifyUser(), no relay-side change needed" mechanism.
 */
function startTestServer(sendPush) {
  const store = new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'push-subscription/', adapter: new NullAdapter(), replicate: false },
  ]);
  return startTestRelayServer({ store, allowDynamicSubscribe: true, sendPush, pushSubscriptions: new Map(), pushRules: [createNotificationPushRule()] });
}

async function closeAll(server, ...channels) {
  for (const ch of channels) await ch.close().catch(() => {});
  await stopTestRelayServer(server);
}

async function registerPush(qu, repl, subscription) {
  await qu.session.publish(`push-subscription/${qu.fingerprint}`, subscription);
  await repl.sync({ topic: `push-subscription/${qu.fingerprint}` });
}

test('an offline recipient with a registered push subscription gets notified when qu.notifyUser() is called — no app-specific push rule needed', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async ({ subscription, payload }) => { pushCalls.push({ subscription, payload }); });

  const sender = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createNotificationsPlugin());
  const recipient = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());

  const chRecipientRegister = createWebSocketChannel(url);
  const chSender = createWebSocketChannel(url);
  try {
    await chRecipientRegister.connect();
    const replRecipientRegister = await recipient.connect(chRecipientRegister, { pushTopics: [''] });
    const fakeSubscription = { endpoint: 'https://push.example.test/recipient', keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } };
    await registerPush(recipient, replRecipientRegister, fakeSubscription);
    replRecipientRegister.close();
    await chRecipientRegister.close();
    await wait(50);

    await chSender.connect();
    await sender.connect(chSender, { pushTopics: [''] });
    await sender.notifyUser(recipient.fingerprint, { appId: 'test-app', kind: 'mention', message: 'Du wurdest erwähnt' });
    await wait(150);

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].subscription.endpoint, fakeSubscription.endpoint);
    assert.equal(pushCalls[0].payload.fp, sender.fingerprint);
    assert.match(pushCalls[0].payload.body, /Du wurdest erwähnt/);
    assert.equal(pushCalls[0].payload.title, 'QUniverse');
  } finally {
    await closeAll(server, chRecipientRegister, chSender);
  }
});

test('an ONLINE recipient does not get pushed at (already receiving it live)', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async (call) => { pushCalls.push(call); });

  const sender = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createNotificationsPlugin());
  const recipient = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());

  const chSender = createWebSocketChannel(url);
  const chRecipient = createWebSocketChannel(url);
  try {
    await chRecipient.connect();
    const replRecipient = await recipient.connect(chRecipient, { pushTopics: [''] });
    await registerPush(recipient, replRecipient, { endpoint: 'https://push.example.test/online', keys: { p256dh: 'x', auth: 'y' } });

    await chSender.connect();
    await sender.connect(chSender, { pushTopics: [''] });
    await sender.notifyUser(recipient.fingerprint, { message: 'recipient is online, no push needed' });
    await wait(150);

    assert.equal(pushCalls.length, 0);
  } finally {
    await closeAll(server, chSender, chRecipient);
  }
});

test('a notification from ANOTHER app still reaches the same generic rule (no per-app opt-in required)', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async ({ payload }) => { pushCalls.push(payload); });

  const sender = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createNotificationsPlugin());
  const recipient = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());

  const chRecipientRegister = createWebSocketChannel(url);
  const chSender = createWebSocketChannel(url);
  try {
    await chRecipientRegister.connect();
    const replRecipientRegister = await recipient.connect(chRecipientRegister, { pushTopics: [''] });
    await registerPush(recipient, replRecipientRegister, { endpoint: 'https://push.example.test/forum', keys: { p256dh: 'a', auth: 'b' } });
    replRecipientRegister.close();
    await chRecipientRegister.close();
    await wait(50);

    await chSender.connect();
    await sender.connect(chSender, { pushTopics: [''] });
    await sender.notifyUser(recipient.fingerprint, { appId: 'forum', kind: 'reply', message: 'Neue Antwort auf deinen Beitrag' });
    await wait(150);

    assert.equal(pushCalls.length, 1);
    assert.match(pushCalls[0].body, /Neue Antwort/);
  } finally {
    await closeAll(server, chRecipientRegister, chSender);
  }
});

test('no message field falls back to a generic body mentioning the sender\'s alias, if published', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async ({ payload }) => { pushCalls.push(payload); });

  const sender = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createNotificationsPlugin());
  const recipient = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());

  const chRecipientRegister = createWebSocketChannel(url);
  const chSender = createWebSocketChannel(url);
  try {
    await chRecipientRegister.connect();
    const replRecipientRegister = await recipient.connect(chRecipientRegister, { pushTopics: [''] });
    await registerPush(recipient, replRecipientRegister, { endpoint: 'https://push.example.test/noalias', keys: { p256dh: 'a', auth: 'b' } });
    replRecipientRegister.close();
    await chRecipientRegister.close();
    await wait(50);

    await chSender.connect();
    const replSender = await sender.connect(chSender, { pushTopics: [''] });
    await sender.publishProfile({ alias: 'Sender-Name' });
    await replSender.sync({ topic: sender.userSpaceId });
    await sender.notifyUser(recipient.fingerprint, { appId: 'test-app', kind: 'ping' }); // no `message` field at all
    await wait(150);

    assert.equal(pushCalls.length, 1);
    assert.match(pushCalls[0].body, /Sender-Name/);
  } finally {
    await closeAll(server, chRecipientRegister, chSender);
  }
});
