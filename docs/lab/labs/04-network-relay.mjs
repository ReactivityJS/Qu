// Lab 4: Netzwerk — echter WebSocket-Relay (derselbe Prozess, der diese
// Seite ausliefert, siehe index.js), Replikation, reziproker Sync, und
// Datei-Mirroring (der Relay zieht sich Chunks vom Uploader, solange der
// verbunden ist — spätere Clients laden vom Relay, nicht vom Original).
// Spiegelt test/relay.test.mjs und test/relay-mirror.test.mjs' Szenarien,
// nur gegen den echten, laufenden Relay statt einen Test-Server.
//
// 'qu-demo-room' ist der feste Topic-Präfix, den index.js dem Relay als
// pushTopics mitgibt (Live-Push funktioniert nur dafür) UND das Muster,
// auf das relay.mjs' proaktives Datei-Mirroring reagiert
// (`runtime.on('*/files/**', ...)` — "files" muss GENAU das zweite
// Pfadsegment sein, also bleibt der Raum selbst absichtlich unrandomisiert;
// nur Nachrichten-/Datei-IDs innerhalb des Raums bekommen einen zufälligen
// Suffix, damit wiederholte Läufe sich nicht gegenseitig Inhalte unterschieben.
import {
  Qu, createWebSocketChannel, createNetworkPlugin, createSpacesPlugin,
  createFileHandlerPlugin, MemoryFileStorageAdapter, reassembleFile,
} from '../../../src/index.js';

function relayUrl() {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/relay`;
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * A `sync.request` sent the instant a connection is authenticated can, on
 * a real network, race the relay's own handshake→attach sequence: if it
 * arrives in the narrow gap between authenticateChannel()'s own listener
 * resolving+detaching and DefaultReplication's listener being registered
 * (hub.attach() in relay.mjs), it lands on a listener that doesn't
 * recognize the message type and is silently dropped — a pre-existing
 * relay/hub race that Loopback-channel tests never hit (no real async
 * jitter there) but a real WebSocket round-trip occasionally does. Same
 * "might not be ready yet, retry" resilience DefaultFileTransfer's own
 * chunk requests already use, applied here instead of masking it with a
 * longer single timeout.
 */
async function syncWithRetry(repl, opts, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try { return await repl.sync(opts); } catch (e) {
      if (i === attempts) throw e;
    }
  }
}

export const steps = [
  {
    id: 'connect',
    title: '1 · Zwei Clients verbinden sich über den echten Relay',
    description: 'Derselbe WebSocket-Relay, der diese Seite ausliefert (index.js). qu.connect() beweist zuerst den Fingerprint der Gegenseite (Challenge-Response gegen den Relay), dann verdrahtet es Replication.',
    code: `const roomId = 'qu-demo-room'; // fest — der Relay mirrort Dateien nur unter <ein-Segment>/files/**
const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const chA = createWebSocketChannel(relayUrl());
const chB = createWebSocketChannel(relayUrl());
await chA.connect();
await chB.connect();
const replA = await alice.connect(chA, { pushTopics: [\`\${roomId}/\`] });
const replB = await bob.connect(chB, { pushTopics: [\`\${roomId}/\`] });`,
    kind: 'info',
    async run(ctx) {
      ctx.roomId = 'qu-demo-room'; // fest — der Relay mirrort Dateien nur unter <ein-Segment>/files/**
      ctx.alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
      ctx.bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
      ctx.chA = createWebSocketChannel(relayUrl());
      ctx.chB = createWebSocketChannel(relayUrl());
      await ctx.chA.connect();
      await ctx.chB.connect();
      ctx.replA = await ctx.alice.connect(ctx.chA, { pushTopics: [`${ctx.roomId}/`] });
      ctx.replB = await ctx.bob.connect(ctx.chB, { pushTopics: [`${ctx.roomId}/`] });
      window.aliceNet = ctx.alice;
      window.bobNet = ctx.bob;
      return { 'Raum': ctx.roomId, 'Alice sieht Bob (bewiesen)': ctx.replA.peerFingerprint, 'Bob sieht Alice (bewiesen)': ctx.replB.peerFingerprint };
    },
  },
  {
    id: 'live-push',
    title: '2 · Live-Push: kein sync() nötig',
    description: 'Alice schreibt — weil der Raum unter ihren pushTopics steht, pusht der Relay das sofort an Bob weiter.',
    code: `await alice.get(\`\${roomId}/msg1\`).put({ text: 'Hallo Bob, live über den echten Relay!' });`,
    kind: 'chat',
    async run(ctx) {
      await ctx.alice.get(`${ctx.roomId}/msg1`).put({ text: 'Hallo Bob, live über den echten Relay!' });
      await wait(150);
      const bobView = await ctx.bob.session.query(`${ctx.roomId}/**`);
      return { 'Bob hat empfangen (ohne sync!)': bobView.length > 0, Text: bobView[0]?.value?.text };
    },
  },
  {
    id: 'later-client-sync',
    title: '3 · Ein später verbindender Client holt sich die Historie per sync()',
    description: 'Carol verbindet sich NACHDEM Alice schon geschrieben hat — ein einziger sync()-Aufruf holt die komplette bisherige Historie des Raums vom Relay.',
    code: `const carol = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const chC = createWebSocketChannel(relayUrl());
await chC.connect();
const replC = await carol.connect(chC, { pushTopics: [\`\${roomId}/\`] });
await syncWithRetry(replC, { topic: roomId, since: 0 });`,
    kind: 'info',
    async run(ctx) {
      ctx.carol = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
      ctx.chC = createWebSocketChannel(relayUrl());
      await ctx.chC.connect();
      ctx.replC = await ctx.carol.connect(ctx.chC, { pushTopics: [`${ctx.roomId}/`] });
      await syncWithRetry(ctx.replC, { topic: ctx.roomId, since: 0 });
      const carolView = await ctx.carol.session.query(`${ctx.roomId}/**`);
      window.carolNet = ctx.carol;
      return { 'Carol sieht (war offline für Schritt 2)': carolView.length, Text: carolView[0]?.value?.text };
    },
  },
  {
    id: 'file-mirror',
    title: '4 · Datei teilen + Relay-Mirror',
    description: 'Alice teilt eine Datei und trennt dann die Verbindung. Ein neuer Client (Dave) kann sie trotzdem laden — nicht von Alice (die ist weg), sondern vom Relay, der die Chunks proaktiv gespiegelt hat, solange Alice noch verbunden war.',
    code: `const aliceFiles = new MemoryFileStorageAdapter();
alice.use(createFileHandlerPlugin({ fileStorage: aliceFiles }));
const xferAlice = alice.fileTransfer(chA, aliceFiles);
const { manifestId } = await alice.shareFile(\`\${roomId}/files/report\`, bytes, { name: 'report.txt', fileStorage: aliceFiles });
await new Promise((r) => setTimeout(r, 300)); // Relay Zeit geben, die Chunks zu spiegeln
replA.close(); xferAlice.close(); await chA.close(); // Alice ist jetzt komplett weg

const daveFiles = new MemoryFileStorageAdapter();
const dave = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createFileHandlerPlugin({ fileStorage: daveFiles }));
const replDave = await dave.connect(chDave, { pushTopics: [\`\${roomId}/\`] });
await syncWithRetry(replDave, { topic: roomId, since: 0 }); // holt das Manifest
const xferDave = dave.fileTransfer(chDave, daveFiles);
await xferDave.requestFile(manifestId); // kommt vom Relay, nicht von Alice`,
    kind: 'file',
    async run(ctx) {
      const aliceFiles = new MemoryFileStorageAdapter();
      ctx.alice.use(createFileHandlerPlugin({ fileStorage: aliceFiles }));
      const xferAlice = ctx.alice.fileTransfer(ctx.chA, aliceFiles);
      const bytes = new TextEncoder().encode('Lab-Bericht: Mirroring funktioniert.\n'.repeat(200));
      const { manifestId } = await ctx.alice.shareFile(`${ctx.roomId}/files/report`, bytes, { name: 'report.txt', fileStorage: aliceFiles });

      await wait(400); // dem Relay Zeit geben, die Chunks von Alice zu spiegeln
      ctx.replA.close();
      xferAlice.close();
      await ctx.chA.close(); // Alice ist jetzt komplett weg

      const daveFiles = new MemoryFileStorageAdapter();
      const dave = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin()).use(createFileHandlerPlugin({ fileStorage: daveFiles }));
      const chDave = createWebSocketChannel(relayUrl());
      await chDave.connect();
      const replDave = await dave.connect(chDave, { pushTopics: [`${ctx.roomId}/`] });
      await syncWithRetry(replDave, { topic: ctx.roomId, since: 0 });

      const xferDave = dave.fileTransfer(chDave, daveFiles);
      await xferDave.requestFile(manifestId);
      const manifest = (await dave.get(manifestId)).value;
      const received = await reassembleFile(daveFiles, manifest);

      xferDave.close();
      await chDave.close();
      await ctx.chB.close();
      ctx.replB.close();
      await ctx.chC?.close();
      ctx.replC?.close();

      return {
        Datei: manifest.name,
        Chunks: manifest.chunks.length,
        'Byte-identisch (vom Relay geladen, nicht von Alice)': received.length === bytes.length && received.every((b, i) => b === bytes[i]),
      };
    },
  },
];
