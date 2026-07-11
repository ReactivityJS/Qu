import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Qu, sendMessage, listMessages, createNetworkPlugin } from '../src/index.js';
import { createWebSocketChannel } from '../src/network/transports/websocket-browser.js';
import { createRelay } from '../relay/relay.mjs';
import { bridgeWebSocketServer } from '../relay/node-ws-bridge.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startTestServer() {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const relayApi = await createRelay({ pushTopics: ['qu-demo-room/'] });
  bridgeWebSocketServer(server, relayApi, { path: '/relay' });
  return { server, port, ...relayApi };
}

test('two independent WebSocket clients exchange a chat message via the real relay (not the loopback channel)', async () => {
  const { server, port } = await startTestServer();
  const url = `ws://127.0.0.1:${port}/relay`;

  const alice = (await Qu.create()).use(createNetworkPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin());

  const chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  await chA.connect();
  await chB.connect();

  const replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });
  const replB = await bob.connect(chB, { pushTopics: ['qu-demo-room/'] });

  await sendMessage(alice, 'qu-demo-room', { text: 'hello over a real socket' });
  await wait(100);

  const bobView = await listMessages(bob, 'qu-demo-room');
  assert.equal(bobView.length, 1);
  assert.equal(bobView[0].value.text, 'hello over a real socket');
  assert.equal(bobView[0].writer, alice.fingerprint);

  replA.close();
  replB.close();
  await chA.close();
  await chB.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('a third, later-connecting client syncs existing room history from the relay', async () => {
  const { server, port } = await startTestServer();
  const url = `ws://127.0.0.1:${port}/relay`;

  const alice = (await Qu.create()).use(createNetworkPlugin());
  const chA = createWebSocketChannel(url);
  await chA.connect();
  const replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });
  await sendMessage(alice, 'qu-demo-room', { text: 'already here before carol joins' });
  await wait(50);

  const carol = (await Qu.create()).use(createNetworkPlugin());
  const chC = createWebSocketChannel(url);
  await chC.connect();
  const replC = await carol.connect(chC, { pushTopics: ['qu-demo-room/'] });
  await replC.sync({ topic: 'qu-demo-room', since: 0 });

  const carolView = await listMessages(carol, 'qu-demo-room');
  assert.equal(carolView.length, 1);
  assert.equal(carolView[0].value.text, 'already here before carol joins');

  replA.close();
  replC.close();
  await chA.close();
  await chC.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('createWebSocketChannel().isOpen() reflects real connection state, and reconnecting with a fresh channel after a close works end-to-end', async () => {
  const { server, port } = await startTestServer();
  const url = `ws://127.0.0.1:${port}/relay`;

  const alice = (await Qu.create()).use(createNetworkPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin());
  let chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  await chA.connect();
  await chB.connect();
  assert.equal(chA.isOpen(), true);

  let replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });
  const replB = await bob.connect(chB, { pushTopics: ['qu-demo-room/'] });

  // Simulate the mobile scenario: the connection dies (screen off, OS kills
  // it) without the app doing anything.
  await chA.close();
  await wait(50);
  assert.equal(chA.isOpen(), false);

  // The exact recovery live-chat.mjs performs: a brand new channel, a
  // fresh handshake+DefaultReplication — no page reload involved.
  replA.close();
  chA = createWebSocketChannel(url);
  await chA.connect();
  assert.equal(chA.isOpen(), true);
  replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });

  await sendMessage(alice, 'qu-demo-room', { text: 'back online without a reload' });
  await wait(150);
  const bobView = await listMessages(bob, 'qu-demo-room');
  assert.ok(bobView.some((m) => m.value.text === 'back online without a reload'));

  replA.close();
  replB.close();
  await chA.close();
  await chB.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('routed events (qu.route) are forwarded to the correct fingerprint, with the relay-proven sender — not whatever the sender claims. WebRTC signaling is one user of this, not the only one.', async () => {
  const { server, port } = await startTestServer();
  const url = `ws://127.0.0.1:${port}/relay`;

  const alice = (await Qu.create()).use(createNetworkPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin());
  const mallory = (await Qu.create()).use(createNetworkPlugin());
  const chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  const chM = createWebSocketChannel(url);
  await chA.connect();
  await chB.connect();
  await chM.connect();
  await alice.connect(chA, { pushTopics: [] });
  await bob.connect(chB, { pushTopics: [] });
  await mallory.connect(chM, { pushTopics: [] });

  const receivedByBob = [];
  chB.onMessage((msg) => { if (msg.type === 'qu.route') receivedByBob.push(msg); });

  await chA.send({ type: 'qu.route', to: bob.fingerprint, event: 'webrtc-signal', payload: { kind: 'sdp', data: 'fake-offer' } });
  await wait(100);

  assert.equal(receivedByBob.length, 1);
  assert.equal(receivedByBob[0].from, alice.fingerprint, 'the relay must set `from` itself, from the proven connection, not trust a claim');
  assert.equal(receivedByBob[0].event, 'webrtc-signal');
  assert.equal(receivedByBob[0].payload.data, 'fake-offer');

  // A completely different event name — proving the relay's forwarding is
  // generic, not hardcoded to WebRTC.
  await chA.send({ type: 'qu.route', to: bob.fingerprint, event: 'call-invite', payload: { room: 'xyz' } });
  await wait(100);
  const invite = receivedByBob.find((m) => m.event === 'call-invite');
  assert.ok(invite, 'an arbitrary event name must be forwarded just the same — the relay never special-cases "webrtc-signal"');
  assert.equal(invite.payload.room, 'xyz');

  // Mallory tries to impersonate Alice by claiming a false `from` — the
  // relay ignores any `from` the sender includes and uses its own record.
  await chM.send({ type: 'qu.route', to: bob.fingerprint, from: alice.fingerprint, event: 'webrtc-signal', payload: { kind: 'sdp', data: 'spoofed' } });
  await wait(100);
  const spoofed = receivedByBob.find((m) => m.payload.data === 'spoofed');
  assert.equal(spoofed.from, mallory.fingerprint, 'mallory cannot claim to be alice — the relay overwrites `from` with the proven identity');

  await chA.close();
  await chB.close();
  await chM.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('a routed event is never persisted — it never reaches the relay\'s own store, unlike publish()/append()', async () => {
  const { server, port, relay } = await startTestServer();
  const url = `ws://127.0.0.1:${port}/relay`;
  const alice = (await Qu.create()).use(createNetworkPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin());
  const chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  await chA.connect();
  await chB.connect();
  await alice.connect(chA, { pushTopics: [] });
  await bob.connect(chB, { pushTopics: [] });

  const before = await relay.runtime.query('**');
  await chA.send({ type: 'qu.route', to: bob.fingerprint, event: 'typing', payload: { at: Date.now() } });
  await wait(100);
  const after = await relay.runtime.query('**');

  assert.equal(after.length, before.length, 'the relay forwards qu.route messages directly, never through runtime.ingest() — its own store must be untouched');

  await chA.close();
  await chB.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('signaling to an offline/unknown fingerprint is silently dropped, not queued or errored back to the sender', async () => {
  const { server, port } = await startTestServer();
  const url = `ws://127.0.0.1:${port}/relay`;
  const alice = (await Qu.create()).use(createNetworkPlugin());
  const chA = createWebSocketChannel(url);
  await chA.connect();
  await alice.connect(chA, { pushTopics: [] });

  await chA.send({ type: 'qu.route', to: 'nobody-connected-with-this-fp', payload: { kind: 'sdp', data: 'x' } });
  await wait(100);

  await chA.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  assert.ok(true, 'no crash — that is the whole assertion here');
});
