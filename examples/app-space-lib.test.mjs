import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Qu, createNetworkPlugin, createSpacesPlugin } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { bridgeWebSocketServer } from '../relay/node-ws-bridge.mjs';
import { connectToRelay, openAppSpace, restrictedAppSpace, postEntry, listEntries, onEntry } from './app-space-lib.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** A real relay over a real WebSocket server on an ephemeral port — not a loopback channel, the same infrastructure test/relay.test.mjs uses, because this example is specifically about "over the wire", not just "in one process". */
async function startTestRelay(pushTopics) {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const relayApi = await createRelay({ pushTopics });
  bridgeWebSocketServer(server, relayApi, { path: '/relay' });
  return { server, url: `ws://127.0.0.1:${port}/relay` };
}

async function stopTestRelay(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test('two independent app instances exchange data through a shared, open App-Space over a real relay', async () => {
  const APP_SPACE = 'my-app';
  const { server, url } = await startTestRelay([`${APP_SPACE}/`]);

  const instanceA = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const instanceB = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { channel: chA, repl: replA } = await connectToRelay(instanceA, url, { pushTopics: [`${APP_SPACE}/`] });
  const { channel: chB, repl: replB } = await connectToRelay(instanceB, url, { pushTopics: [`${APP_SPACE}/`] });

  const spaceA = openAppSpace(instanceA, APP_SPACE);
  const spaceB = openAppSpace(instanceB, APP_SPACE);

  await postEntry(spaceA, 'hello from instance A');
  await wait(100);

  const seenByB = await listEntries(spaceB);
  assert.equal(seenByB.length, 1, 'instance B must see the entry instance A wrote, delivered by the relay, not shared local state');
  assert.equal(seenByB[0].value.text, 'hello from instance A');
  assert.equal(seenByB[0].writer, instanceA.fingerprint, 'the verified writer field, not just "some entry appeared"');

  replA.close();
  replB.close();
  await chA.close();
  await chB.close();
  await stopTestRelay(server);
});

test('onEntry() delivers a live update to a peer without polling, and a late joiner catches up via sync()', async () => {
  const APP_SPACE = 'live-app';
  const { server, url } = await startTestRelay([`${APP_SPACE}/`]);

  const instanceA = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const instanceB = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { channel: chA, repl: replA } = await connectToRelay(instanceA, url, { pushTopics: [`${APP_SPACE}/`] });
  const { channel: chB, repl: replB } = await connectToRelay(instanceB, url, { pushTopics: [`${APP_SPACE}/`] });

  const spaceA = openAppSpace(instanceA, APP_SPACE);
  const spaceB = openAppSpace(instanceB, APP_SPACE);

  const liveSeenByB = [];
  onEntry(spaceB, (q) => liveSeenByB.push(q.value.text));

  await postEntry(spaceA, 'first');
  await postEntry(spaceA, 'second');
  await wait(100);

  assert.deepEqual(liveSeenByB.sort(), ['first', 'second'], 'B must receive both entries live, no polling involved');

  // A third instance joins LATE — never saw the live pushes, must sync() to catch up.
  const instanceC = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { channel: chC, repl: replC } = await connectToRelay(instanceC, url, { pushTopics: [`${APP_SPACE}/`] });
  await replC.sync({ topic: APP_SPACE, since: 0 });

  const spaceC = openAppSpace(instanceC, APP_SPACE);
  const seenByC = await listEntries(spaceC);
  assert.deepEqual(seenByC.map((e) => e.value.text).sort(), ['first', 'second'], 'a late joiner must be able to fetch existing history via sync(), not just future live pushes');

  replA.close();
  replB.close();
  replC.close();
  await chA.close();
  await chB.close();
  await chC.close();
  await stopTestRelay(server);
});

test('a member-restricted App-Space rejects a write from a non-member, even when it arrives over the network', async () => {
  const { server, url } = await startTestRelay(['']); // pushTopics: '' — restrictedAppSpace()'s id is a random UUID, not knowable in advance

  const owner = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const outsider = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const { channel: chOwner, repl: replOwner } = await connectToRelay(owner, url, { pushTopics: [''] });
  const { channel: chOutsider, repl: replOutsider } = await connectToRelay(outsider, url, { pushTopics: [''] });

  const space = restrictedAppSpace(owner, [owner.fingerprint]);
  await space.ready; // guarantees the manifest landed in owner's OWN store — the push to the relay itself is a separate, un-awaited async step
  await wait(50); // let that push actually reach the relay before the outsider asks it for the manifest
  // The outsider explicitly syncs first — an optimistic local write attempt
  // is only meaningfully "rejected" once this instance actually knows the
  // real manifest; without this, its own runtime wouldn't know the Space
  // is restricted yet and would (locally, briefly, incorrectly) accept the
  // write under the open bootstrap default, only to have the relay itself
  // reject it moments later — same end state, but a much racier test.
  await replOutsider.sync({ topic: space.id, since: 0 });

  await assert.rejects(
    () => postEntry(outsider.get(space.id), 'an outsider tries to sneak in'),
    /\[ACL\] Write denied/,
    'the outsider is not in `writers` — denied locally before anything is even sent, and would be denied again by the relay\'s own ACL check if it somehow arrived',
  );

  await wait(50);
  const entries = await listEntries(owner.get(space.id));
  assert.equal(entries.length, 0, 'the rejected write must never have reached the shared App-Space at all');

  replOwner.close();
  replOutsider.close();
  await chOwner.close();
  await chOutsider.close();
  await stopTestRelay(server);
});
