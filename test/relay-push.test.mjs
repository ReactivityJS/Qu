import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Qu, createNetworkPlugin, createSpacesPlugin, createChatPlugin } from '../src/index.js';
import { createWebSocketChannel } from '../src/network/transports/websocket-browser.js';
import { createRelay } from '../relay/relay.mjs';
import { bridgeWebSocketServer } from '../relay/node-ws-bridge.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * Wires a relay with a FAKE sendPush() — asserts the relay's own decision
 * logic (who gets notified, with what payload, and crucially who does
 * NOT) without ever making a real network call to a push service. The
 * actual Web Push wire format (VAPID + aes128gcm) is covered separately
 * and exhaustively in relay/webpush.test.mjs; this file is purely about
 * relay.mjs's wiring: "an offline DM room member with a registered
 * subscription gets pushed at when a new message lands, everyone else
 * does not."
 *
 * Every test below wraps its assertions in try/finally — an assertion
 * failure part-way through must still close its sockets/server, or the
 * open WebSocket connection keeps the whole `node --test` process alive
 * well past its actual test failure (a real, easy-to-hit trap: this
 * exact omission previously turned one failing assertion into an
 * indefinite hang instead of a clean, fast failure).
 */
async function startTestServer(sendPush) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const relayApi = await createRelay({ allowDynamicSubscribe: true, sendPush, pushSubscriptions: new Map() });
  bridgeWebSocketServer(server, relayApi, { path: '/relay' });
  return { server, port, url: `ws://127.0.0.1:${port}/relay`, ...relayApi };
}

async function closeAll(server, ...channels) {
  for (const ch of channels) await ch.close().catch(() => {});
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('an offline DM member with a registered push subscription gets notified when a message arrives', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async ({ subscription, payload }) => { pushCalls.push({ subscription, payload }); });

  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());

  const chBRegister = createWebSocketChannel(url);
  const chA = createWebSocketChannel(url);
  try {
    // Bob registers a push subscription, then disconnects entirely — "app closed".
    await chBRegister.connect();
    const replBRegister = await bob.connect(chBRegister, { pushTopics: [''] });
    const fakeSubscription = { endpoint: 'https://push.example.test/bob', keys: { p256dh: 'fake-p256dh', auth: 'fake-auth' } };
    await chBRegister.send({ type: 'qu.push.subscribe', subscription: fakeSubscription });
    await wait(50);
    replBRegister.close();
    await chBRegister.close();
    await wait(50);

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    // Alice's alias must actually be at the relay BEFORE she sends — same
    // "publish, then sync your own userspace" requirement examples/chat/
    // app.mjs's ensureAlias() documents (fire-and-forget pushTopics alone
    // races the message below).
    await alice.publishProfile({ alias: 'Alice' });
    await replA.sync({ topic: alice.userSpaceId });

    const roomId = `dm-${[alice.fingerprint, bob.fingerprint].sort().join('-')}`;
    await alice.session.publish(roomId, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'], admins: [alice.fingerprint, bob.fingerprint], createdAt: Date.now() });
    await wait(30);
    await alice.sendMessage(roomId, { text: 'hallo bob' });
    await wait(150);

    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].subscription.endpoint, fakeSubscription.endpoint);
    assert.equal(pushCalls[0].payload.fp, alice.fingerprint);
    assert.match(pushCalls[0].payload.body, /Alice/);
  } finally {
    await closeAll(server, chBRegister, chA);
  }
});

test('an ONLINE DM member does not get pushed at (already receiving it live)', async () => {
  const pushCalls = [];
  const { server, url } = await startTestServer(async (call) => { pushCalls.push(call); });

  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());

  const chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  try {
    await chB.connect();
    const replB = await bob.connect(chB, { pushTopics: [''] });
    await chB.send({ type: 'qu.push.subscribe', subscription: { endpoint: 'https://push.example.test/bob-online', keys: { p256dh: 'x', auth: 'y' } } });
    await wait(50);

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    const roomId = `dm-${[alice.fingerprint, bob.fingerprint].sort().join('-')}`;
    await alice.session.publish(roomId, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'], admins: [alice.fingerprint, bob.fingerprint], createdAt: Date.now() });
    await wait(30);
    await alice.sendMessage(roomId, { text: 'bob is online, no push needed' });
    await wait(150);

    assert.equal(pushCalls.length, 0);
    replA.close();
    replB.close();
  } finally {
    await closeAll(server, chA, chB);
  }
});

test('a subscription is dropped after a 410 Gone from the push service', async () => {
  const sendPush = async () => { const e = new Error('gone'); e.status = 410; throw e; };
  const { server, url, pushSubscriptions } = await startTestServer(sendPush);

  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());

  const chB = createWebSocketChannel(url);
  const chA = createWebSocketChannel(url);
  try {
    await chB.connect();
    const replB = await bob.connect(chB, { pushTopics: [''] });
    await chB.send({ type: 'qu.push.subscribe', subscription: { endpoint: 'https://push.example.test/dead', keys: { p256dh: 'x', auth: 'y' } } });
    await wait(50);
    replB.close();
    await chB.close();
    await wait(50);

    assert.equal(pushSubscriptions.has(bob.fingerprint), true);

    await chA.connect();
    const replA = await alice.connect(chA, { pushTopics: [''] });
    const roomId = `dm-${[alice.fingerprint, bob.fingerprint].sort().join('-')}`;
    await alice.session.publish(roomId, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'], admins: [alice.fingerprint, bob.fingerprint], createdAt: Date.now() });
    await wait(30);
    await alice.sendMessage(roomId, { text: 'this push will fail with 410' });
    await wait(150);

    assert.equal(pushSubscriptions.has(bob.fingerprint), false);
    replA.close();
  } finally {
    await closeAll(server, chB, chA);
  }
});
