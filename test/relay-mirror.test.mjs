import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { Qu, sendMessage, listMessages, createWebSocketChannel, MemoryFileStorageAdapter, reassembleFile, createNetworkPlugin, createFileHandlerPlugin, createSpacesPlugin } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { bridgeWebSocketServer } from '../relay/node-ws-bridge.mjs';
import { QuStore, NullAdapter } from '../src/index.js';
import { FileSystemStorageAdapter } from '../src/adapters/node-fs.js';
import { FileSystemFileStorageAdapter } from '../src/adapters/node-fs-file-storage.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function tmpDir(name) {
  const dir = path.join(os.tmpdir(), `qu-relay-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function startTestServer({ dataDir, pushTopics = ['qu-demo-room/'] } = {}) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const relayOpts = { pushTopics };
  if (dataDir) {
    relayOpts.store = new QuStore([
      { prefix: '', adapter: new FileSystemStorageAdapter(path.join(dataDir, 'qubits.ndjson')) },
      { prefix: 'signal/', adapter: new NullAdapter() },
    ]);
    relayOpts.fileStorage = new FileSystemFileStorageAdapter(path.join(dataDir, 'files'));
  }
  const relayApi = await createRelay(relayOpts);
  bridgeWebSocketServer(server, relayApi, { path: '/relay' });
  return { server, port, ...relayApi };
}

async function closeAll(server, ...channels) {
  for (const ch of channels) await ch?.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('a file survives the uploader disconnecting: the relay mirrors it and serves it to a later client', async (t) => {
  const { server, port } = await startTestServer(); // in-memory storage is enough here — the point is mirroring across connections, not restarts
  // Registered immediately, in ADDITION to this test's own explicit
  // closeAll() below — a t.after() hook still runs even if the test body
  // throws before reaching that closeAll() call, which would otherwise
  // leak this still-listening server and hang the whole CI run (the exact
  // bug examples/app-space-lib.test.mjs's doc comment describes). Safe to
  // have both: server.close() on an already-closed server just calls its
  // callback with a harmless "Server is not running" error, never throws.
  t.after(() => closeAll(server).catch(() => {}));
  const url = `ws://127.0.0.1:${port}/relay`;

  const aliceFiles = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createFileHandlerPlugin({ fileStorage: aliceFiles })).use(createSpacesPlugin());
  const chA = createWebSocketChannel(url);
  await chA.connect();
  const replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });

  const xferAlice = alice.fileTransfer(chA, aliceFiles); // serves the relay's chunk requests — without this the mirror pull has no one to answer it
  const original = new TextEncoder().encode('mirrored across a disconnect'.repeat(50));
  const { manifestId } = await alice.shareFile('qu-demo-room/files/agenda', original, { name: 'agenda.txt', fileStorage: aliceFiles });

  await wait(300); // let the relay finish mirroring the chunks from alice before she leaves

  replA.close();
  xferAlice.close();
  await chA.close(); // alice is now fully gone

  const bobFiles = new MemoryFileStorageAdapter();
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createFileHandlerPlugin({ fileStorage: bobFiles })).use(createSpacesPlugin());
  const chB = createWebSocketChannel(url);
  await chB.connect();
  const replB = await bob.connect(chB, { pushTopics: ['qu-demo-room/'] });
  await replB.sync({ topic: 'qu-demo-room', since: 0 }); // picks up the manifest, alice is offline by now

  const xferBob = bob.fileTransfer(chB, bobFiles);
  await xferBob.requestFile(manifestId); // must come FROM THE RELAY's mirror, alice can't answer anymore
  const manifest = (await bob.get(manifestId)).value;
  const received = await reassembleFile(bobFiles, manifest);

  assert.deepEqual(received, original);

  xferBob.close();
  await closeAll(server, chB);
});

test('chat data survives a relay restart when given a data directory', async (t) => {
  const dataDir = await tmpDir('persist');
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = await startTestServer({ dataDir });
  t.after(() => closeAll(first.server).catch(() => {})); // see the file's other tests' doc comment — harmless no-op if this test's own closeAll(first.server, ...) below already ran
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const chA = createWebSocketChannel(`ws://127.0.0.1:${first.port}/relay`);
  await chA.connect();
  const replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });
  await sendMessage(alice.get('qu-demo-room'), { text: 'still here after a restart' });
  await wait(100);
  await closeAll(first.server, chA);

  // Simulate the relay process restarting: a brand new server, same dataDir.
  const second = await startTestServer({ dataDir });
  t.after(() => closeAll(second.server).catch(() => {}));
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const chB = createWebSocketChannel(`ws://127.0.0.1:${second.port}/relay`);
  await chB.connect();
  const replB = await bob.connect(chB, { pushTopics: ['qu-demo-room/'] });
  await replB.sync({ topic: 'qu-demo-room', since: 0 });

  const view = await listMessages(bob.get('qu-demo-room'));
  assert.ok(view.some((m) => m.value.text === 'still here after a restart'));

  await closeAll(second.server, chB);
});

test('the signal/ mount dispatches live but is never persisted, not even across a relay restart', async (t) => {
  const dataDir = await tmpDir('signal');
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

  const first = await startTestServer({ dataDir, pushTopics: ['qu-demo-room/', 'signal/'] });
  t.after(() => closeAll(first.server).catch(() => {}));

  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const chA = createWebSocketChannel(`ws://127.0.0.1:${first.port}/relay`);
  await chA.connect();
  const replA = await alice.connect(chA, { pushTopics: ['signal/'] });

  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const chB = createWebSocketChannel(`ws://127.0.0.1:${first.port}/relay`);
  await chB.connect();
  const replB = await bob.connect(chB, { pushTopics: ['signal/'] });

  let bobSawIt = false;
  bob.get('signal').map(() => { bobSawIt = true; }, { deep: true });
  await alice.get('signal/webrtc-offer').put({ sdp: 'v=0 ephemeral offer' });
  await wait(100);
  assert.equal(bobSawIt, true, 'signal/ still dispatches live to a currently-connected peer');

  // Directly on the relay's own runtime: nothing should be retrievable afterwards.
  assert.equal(await first.relay.runtime.get('signal/webrtc-offer'), null);

  await closeAll(first.server, chA, chB);

  const second = await startTestServer({ dataDir });
  t.after(() => closeAll(second.server).catch(() => {}));
  assert.equal(await second.relay.runtime.get('signal/webrtc-offer'), null, 'signal/ must not survive a restart either');
  await closeAll(second.server);
});

test('sending a large multi-chunk image through the real relay does not break subsequent messages (regression for the reported bug)', async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => closeAll(server).catch(() => {}));
  const url = `ws://127.0.0.1:${port}/relay`;

  const aliceFiles = new MemoryFileStorageAdapter();
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createFileHandlerPlugin({ fileStorage: aliceFiles })).use(createSpacesPlugin());
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const chA = createWebSocketChannel(url);
  const chB = createWebSocketChannel(url);
  await chA.connect();
  await chB.connect();
  const replA = await alice.connect(chA, { pushTopics: ['qu-demo-room/'] });
  const replB = await bob.connect(chB, { pushTopics: ['qu-demo-room/'] });

  const xferAlice = alice.fileTransfer(chA, aliceFiles);

  // A realistic photo-sized attachment — several MB, well over one 64 KiB
  // chunk, exercising the same multi-chunk manifest + mirroring path a real
  // camera photo would.
  const bigImage = new Uint8Array(3_000_000);
  const { manifestId } = await alice.shareFile('qu-demo-room/files/photo', bigImage, { name: 'photo.jpg', mime: 'image/jpeg', fileStorage: aliceFiles });
  await alice.get('qu-demo-room/msgs').set({ text: 'here is a photo' }, { refs: [manifestId] });

  await wait(400); // give the relay time to start mirroring a file this size

  const bobViewAfterImage = await listMessages(bob.get('qu-demo-room'));
  assert.ok(bobViewAfterImage.some((m) => m.value.text === 'here is a photo'), 'the message accompanying the image must still arrive');

  // The actual regression: does a plain follow-up message still get through?
  await alice.get('qu-demo-room/msgs').set({ text: 'follow-up after the image' });
  await wait(200);
  const bobViewAfterFollowup = await listMessages(bob.get('qu-demo-room'));
  assert.ok(bobViewAfterFollowup.some((m) => m.value.text === 'follow-up after the image'), 'a message sent after a large image must still arrive — this is the reported bug');

  replA.close();
  replB.close();
  xferAlice.close();
  await chA.close();
  await chB.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

test('a mirror that failed while the uploader had no fileTransfer to answer retries automatically once they reconnect with one', async (t) => {
  const { server, port } = await startTestServer();
  t.after(() => closeAll(server).catch(() => {}));
  const url = `ws://127.0.0.1:${port}/relay`;

  const aliceFiles = new MemoryFileStorageAdapter();
  const emptyFiles = new MemoryFileStorageAdapter(); // deliberately never given the chunks below
  const alice = (await Qu.create()).use(createNetworkPlugin()).use(createFileHandlerPlugin({ fileStorage: aliceFiles })).use(createSpacesPlugin());

  // First connection: alice IS reachable and DOES answer chunk requests,
  // but her fileTransfer server here is bound to an empty store — every
  // request gets a fast, real "I don't have it" response (not a silent
  // timeout), so the relay's proactive mirror pull (relay.mjs's
  // `*/files/**` hook) fails quickly and deterministically instead of
  // waiting out DefaultFileTransfer's own 10s-per-attempt timeout. This
  // is the same real-world failure it reproduces either way: a phone
  // upload whose connection drops mid-transfer leaves the relay with a
  // manifest but incomplete/no chunk data on the uploader's own device
  // at that moment.
  const chA1 = createWebSocketChannel(url);
  await chA1.connect();
  const replA1 = await alice.connect(chA1, { pushTopics: ['qu-demo-room/'] });
  const xferAliceEmpty = alice.fileTransfer(chA1, emptyFiles);
  const original = new TextEncoder().encode('retried once alice reconnects with a working transfer'.repeat(20));
  const { manifestId } = await alice.shareFile('qu-demo-room/files/retry-me', original, { name: 'retry.txt', fileStorage: aliceFiles });
  await wait(7000); // requestFile()'s own 6-attempt backoff (data/files/transfer.js) — must actually exhaust before this counts as "failed"

  replA1.close();
  xferAliceEmpty.close();
  await chA1.close();

  // Second connection, same identity — THIS time with a fileTransfer
  // server bound to her REAL file store. Reconnecting alone (no re-
  // upload, no explicit retry call from the client) must be enough to
  // trigger relay.mjs's attachChannel() retry and complete the mirror.
  const chA2 = createWebSocketChannel(url);
  await chA2.connect();
  const replA2 = await alice.connect(chA2, { pushTopics: ['qu-demo-room/'] });
  const xferAlice2 = alice.fileTransfer(chA2, aliceFiles);
  await wait(300);

  replA2.close();
  xferAlice2.close();
  await chA2.close(); // alice fully gone again — a later reader must rely purely on the relay's own now-completed mirror

  const bobFiles = new MemoryFileStorageAdapter();
  const bob = (await Qu.create()).use(createNetworkPlugin()).use(createFileHandlerPlugin({ fileStorage: bobFiles })).use(createSpacesPlugin());
  const chB = createWebSocketChannel(url);
  await chB.connect();
  const replB = await bob.connect(chB, { pushTopics: ['qu-demo-room/'] });
  await replB.sync({ topic: 'qu-demo-room', since: 0 });

  const xferBob = bob.fileTransfer(chB, bobFiles);
  await xferBob.requestFile(manifestId); // must come from the relay's mirrored copy — alice is offline
  const manifest = (await bob.get(manifestId)).value;
  const received = await reassembleFile(bobFiles, manifest);
  assert.deepEqual(received, original);

  xferBob.close();
  await closeAll(server, chB);
});
