// The steps below are the ONE place the demo's logic lives. Both
// chat-demo.mjs (CLI, prints text) and browser-demo.mjs (renders visual
// cards) import this same array and just present the results differently.
//
// Everything here goes through the `Qu` facade (src/qu.js) — this is
// deliberately what an application would actually write, not the lower-
// level Runtime/Store/Session wiring the facade composes internally.

import { Qu, createLoopbackChannelPair, MemoryFileStorageAdapter, reassembleFile, createNetworkPlugin, createFileHandlerPlugin, createSpacesPlugin } from '../src/index.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const steps = [
  {
    id: 'identities',
    title: '1 · Drei Instanzen, drei getrennte Geräte',
    description: 'Jede Qu.create() erzeugt eine eigene Identität UND ein eigenes, unabhängiges Gerät (eigene Runtime, eigener Store) — kein manuelles Verdrahten von Runtime/Store/Session nötig.',
    code: `const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const mallory = await Qu.create();`,
    kind: 'info',
    async run(ctx) {
      ctx.alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
      ctx.bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
      ctx.mallory = await Qu.create();
      return { 'alice.fingerprint': ctx.alice.fingerprint, 'bob.fingerprint': ctx.bob.fingerprint, 'mallory.fingerprint': ctx.mallory.fingerprint };
    },
  },
  {
    id: 'profile',
    title: '2 · Öffentliches Profil — einzelne Felder direkt unter der Root',
    description: 'Kein "/profile"-Objekt: alias/pub/epub liegen als eigene QuBits direkt unter "~<fingerprint>". Der User-Space ist strukturell nur von Alice selbst beschreibbar, auch ohne Manifest.',
    code: `await alice.publishProfile({ alias: 'alice', epub: (await alice.exportKeys()).encPub });
// → schreibt: ~<fp>/pub, ~<fp>/alias, ~<fp>/epub`,
    kind: 'info',
    async run(ctx) {
      await ctx.alice.publishProfile({ alias: 'alice', epub: (await ctx.alice.exportKeys()).encPub });
      return {
        [`${ctx.alice.userSpaceId}/alias`]: 'alice',
        [`${ctx.alice.userSpaceId}/pub`]: ctx.alice.fingerprint,
        [`${ctx.alice.userSpaceId}/epub`]: '(ECDH-Key, JWK)',
      };
    },
  },
  {
    id: 'spoof-rejected',
    title: '3 · Fremdes Schreiben wird abgelehnt',
    description: 'Mallory bekommt Zugriff auf Alice\' Gerät (dasselbe Runtime) und versucht, in Alice\' User-Space zu schreiben. Das scheitert strukturell — ihr Fingerprint ist nicht der Space-Owner.',
    code: `const malloryOnAlicesDevice = await Qu.create({ identity: mallory.identity, runtime: alice.runtime });
await malloryOnAlicesDevice.publish(\`\${alice.userSpaceId}/alias\`, 'hacked');
// → wirft: [ACL] Write denied`,
    kind: 'error',
    expectFailure: true,
    async run(ctx) {
      ctx.malloryOnAlicesDevice = await Qu.create({ identity: ctx.mallory.identity, runtime: ctx.alice.runtime });
      await ctx.malloryOnAlicesDevice.publish(`${ctx.alice.userSpaceId}/alias`, 'hacked');
      return {};
    },
  },
  {
    id: 'guest-readonly',
    title: '4 · Ein Gast kann lesen, aber nicht schreiben',
    description: 'Qu.create({ guest: true }) erzeugt trotzdem eine echte, temporäre Identität (lesbar, adressierbar) — aber jede Schreib-Methode der Fassade lehnt sofort ab, unabhängig von der Space-ACL.',
    code: `const visitor = await Qu.create({ guest: true, runtime: alice.runtime });
await visitor.query(\`\${alice.userSpaceId}/**\`); // funktioniert
await visitor.publish('irgendwas', 'x');           // wirft sofort
// → "[Qu] Guest-Sessions haben kein Schreibrecht"`,
    kind: 'error',
    async run(ctx) {
      const visitor = await Qu.create({ guest: true, runtime: ctx.alice.runtime });
      const canRead = (await visitor.query(`${ctx.alice.userSpaceId}/**`)).length > 0;
      let writeDenied = false;
      try { await visitor.publish('irgendwas', 'x'); } catch { writeDenied = true; }
      return { 'Gast hat eigenen Fingerprint': !!visitor.fingerprint, 'Gast kann lesen': canRead, 'Gast-Schreibversuch abgelehnt': writeDenied };
    },
  },
  {
    id: 'inbox',
    title: '5 · Inbox: ein Space, keine Framework-Ausnahme',
    description: 'Eine Inbox ist kein QU-Konzept — nur ein generischer Space mit "jeder darf schreiben, nur Alice darf lesen", gefunden über eine Referenz im Profil.',
    code: `const inboxId = await alice.createSpace({ writers: ['*'], readers: [alice.fingerprint] });
await alice.publish(\`\${alice.userSpaceId}/links\`, { inbox: inboxId });`,
    kind: 'info',
    async run(ctx) {
      ctx.inboxId = await ctx.alice.createSpace({ writers: ['*'], readers: [ctx.alice.fingerprint] });
      await ctx.alice.publish(`${ctx.alice.userSpaceId}/links`, { inbox: ctx.inboxId });
      return { 'Inbox-Space': ctx.inboxId, Rechte: 'writers: [*], readers: [alice]' };
    },
  },
  {
    id: 'connect',
    title: '6 · Geräte verbinden: Handshake + Replication in einem Aufruf',
    description: 'connect() beweist zuerst den Fingerprint der Gegenseite (Challenge-Response), dann verdrahtet es Replication darüber — reziprok und mit Live-Push für die angegebenen Topics.',
    code: `const { a, b } = createLoopbackChannelPair();
const replAlice = await alice.connect(a, { pushTopics: [\`\${inboxId}/\`] });
const replBob = await bob.connect(b, { pushTopics: [\`\${inboxId}/\`] });`,
    kind: 'info',
    async run(ctx) {
      const { a, b } = createLoopbackChannelPair();
      ctx.chA = a;
      ctx.chB = b;
      [ctx.replAlice, ctx.replBob] = await Promise.all([
        ctx.alice.connect(a, { pushTopics: [`${ctx.inboxId}/`] }),
        ctx.bob.connect(b, { pushTopics: [`${ctx.inboxId}/`] }),
      ]);
      return { 'Alice sieht (bewiesen)': ctx.replAlice.peerFingerprint, 'Bob sieht (bewiesen)': ctx.replBob.peerFingerprint };
    },
  },
  {
    id: 'discover-profile',
    title: '7 · Bob liest Alice\' öffentliches Profil',
    description: 'readProfile() liest alias/pub/epub zusammen. Aus epub lernt Bob, wie er künftig Nachrichten für Alice verschlüsseln kann — kein Out-of-Band-Austausch nötig.',
    code: `await replBob.sync({ topic: alice.userSpaceId, since: 0 });
const profile = await bob.readProfile(alice.fingerprint);
await bob.trustPeer(alice.fingerprint, profile.epub);`,
    kind: 'info',
    async run(ctx) {
      await ctx.replBob.sync({ topic: ctx.alice.userSpaceId, since: 0 });
      const profile = await ctx.bob.readProfile(ctx.alice.fingerprint);
      await ctx.bob.trustPeer(ctx.alice.fingerprint, profile.epub);
      await ctx.alice.trustPeer(ctx.bob.fingerprint, (await ctx.bob.exportKeys()).encPub);
      return { 'Bob sieht Alias': profile.alias, 'Bob sieht Inbox (via links)': (await ctx.bob.get(`${ctx.alice.userSpaceId}/links`)).value.inbox };
    },
  },
  {
    id: 'inbox-message',
    title: '8 · Bob schreibt in Alice\' Inbox — verschlüsselt, live',
    description: 'Jeder darf in die Inbox schreiben (Space-ACL), aber nur Alice und Bob können den Inhalt entschlüsseln. Kein erneutes sync() nötig — Live-Push liefert es sofort.',
    code: `await bob.publish(\`\${inboxId}/msg1\`, { text: 'Hi Alice, willst du einen Kaffee trinken?' }, {
  encryptFor: [alice.fingerprint, bob.fingerprint],
});`,
    kind: 'chat',
    async run(ctx) {
      await ctx.bob.publish(`${ctx.inboxId}/msg1`, { text: 'Hi Alice, willst du einen Kaffee trinken?' }, {
        encryptFor: [ctx.alice.fingerprint, ctx.bob.fingerprint],
      });
      await wait(30);
      const view = await ctx.alice.query(`${ctx.inboxId}/**`);
      return { from: 'Bob', to: 'Alice (Inbox)', text: view[0]?.value?.text, via: 'Live-Push, kein sync() nötig' };
    },
  },
  {
    id: 'inbox-mallory-blocked',
    title: '9 · Mallory kann die Inbox nicht mitlesen',
    description: 'Mallory ist nicht in der Readers-Liste des Inbox-Space — ihre query() liefert nichts, unabhängig von der Verschlüsselung.',
    code: `const view = await malloryOnAlicesDevice.query(\`\${inboxId}/**\`);
// view.length === 0`,
    kind: 'error',
    async run(ctx) {
      const view = await ctx.malloryOnAlicesDevice.query(`${ctx.inboxId}/**`);
      return { 'Mallory sieht Nachrichten': view.length, Grund: 'nicht in readers: [alice.fingerprint]' };
    },
  },
  {
    id: 'chat-room',
    title: '10 · Gemeinsamer Chat-Space',
    description: 'Ein zweiter Space, diesmal mit beiden als Writer. Push läuft live in beide Richtungen.',
    code: `const roomId = await alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });
await alice.publish(\`\${roomId}/msg1\`, { text: 'Klar, 15 Uhr passt!' });`,
    kind: 'chat',
    async run(ctx) {
      ctx.roomId = await ctx.alice.createSpace({ writers: [ctx.alice.fingerprint, ctx.bob.fingerprint], readers: ['*'] });
      [ctx.replAlice2, ctx.replBob2] = await Promise.all([
        ctx.alice.connect(ctx.chA, { pushTopics: [`${ctx.roomId}/`] }),
        ctx.bob.connect(ctx.chB, { pushTopics: [`${ctx.roomId}/`] }),
      ]);
      await ctx.alice.publish(`${ctx.roomId}/msg1`, { text: 'Klar, 15 Uhr passt!' });
      await wait(30);
      const bobView = await ctx.bob.query(`${ctx.roomId}/**`);
      return { from: 'Alice', to: `Raum ${ctx.roomId.slice(0, 8)}…`, text: bobView[0]?.value?.text, 'Bob sieht live': !!bobView.length };
    },
  },
  {
    id: 'reciprocal-sync',
    title: '11 · Reziproker Sync: Offline-Schreiben ohne Extra-Queue',
    description: 'Bob schreibt "offline" (kein sync() aufgerufen). Alice fragt nur EINMAL bei sich selbst nach — die Gegenseite fragt automatisch zurück, und Bobs Nachricht taucht trotzdem bei Alice auf.',
    code: `await bob.publish(\`\${roomId}/msg-offline\`, { text: '(während Bob offline war geschrieben)' });
await replAlice2.sync({ topic: roomId, since: 0 }); // Alice fragt nur für sich selbst
// → Alice bekommt trotzdem Bobs neue Nachricht (reziproke Rückfrage)`,
    kind: 'info',
    async run(ctx) {
      await ctx.bob.publish(`${ctx.roomId}/msg-offline`, { text: '(während Bob offline war geschrieben)' });
      await ctx.replAlice2.sync({ topic: ctx.roomId, since: 0 });
      await wait(30);
      const aliceView = await ctx.alice.query(`${ctx.roomId}/**`);
      const gotIt = aliceView.some((q) => q.value?.text?.includes('offline war'));
      return { "Alice hat Bobs Offline-Nachricht": gotIt, 'Sync-Aufrufe nötig': 1 };
    },
  },
  {
    id: 'file-share',
    title: '12 · Datei teilen: Chunking, Transfer, Reassemblierung',
    description: 'Die Datei wird in Hash-adressierte Chunks zerlegt und als kleines, signiertes Manifest veröffentlicht. Bob fordert nur fehlende Chunks an, prüft jeden per Hash, setzt die Datei wieder zusammen.',
    code: `alice.use(createFileHandlerPlugin({ fileStorage: aliceFiles }));
bob.use(createFileHandlerPlugin({ fileStorage: bobFiles }));
const { manifestId } = await alice.shareFile(\`\${roomId}/files/agenda\`, bytes, { name: 'agenda.txt', fileStorage: aliceFiles });
await xferBob.requestFile(manifestId);
const received = await reassembleFile(bobFiles, manifest);`,
    kind: 'file',
    async run(ctx) {
      ctx.aliceFiles = new MemoryFileStorageAdapter();
      ctx.bobFiles = new MemoryFileStorageAdapter();
      ctx.alice.use(createFileHandlerPlugin({ fileStorage: ctx.aliceFiles }));
      ctx.bob.use(createFileHandlerPlugin({ fileStorage: ctx.bobFiles }));
      const payload = new TextEncoder().encode('Tagesordnung: 1) Kaffee 2) Projektstatus 3) Nächste Schritte\n'.repeat(1200));

      const { manifestId } = await ctx.alice.shareFile(`${ctx.roomId}/files/agenda`, payload, {
        name: 'agenda.txt', mime: 'text/plain', fileStorage: ctx.aliceFiles,
      });
      await ctx.alice.publish(`${ctx.roomId}/msg2`, { text: 'hier die Agenda' }, { refs: [manifestId] });
      await wait(30);

      const { a: chFA, b: chFB } = createLoopbackChannelPair();
      const xferAlice = ctx.alice.fileTransfer(chFA, ctx.aliceFiles);
      const xferBob = ctx.bob.fileTransfer(chFB, ctx.bobFiles);
      await xferBob.requestFile(manifestId);
      const manifest = (await ctx.bob.get(manifestId)).value;
      const received = await reassembleFile(ctx.bobFiles, manifest);
      xferAlice.close();
      xferBob.close();

      ctx.fileManifestId = manifestId;
      return {
        Datei: manifest.name,
        Chunks: manifest.chunks.length,
        'Größe (Bytes)': payload.length,
        'Byte-identisch nach Transfer': received.length === payload.length && received.every((b, i) => b === payload[i]),
      };
    },
  },
  {
    id: 'file-corrupt-rejected',
    title: '13 · Manipulierter Chunk wird abgelehnt',
    description: 'Ein absichtlich verfälschter Chunk (ein Bit gekippt) wird beim Empfänger verworfen, bevor er je gespeichert wird — der Hash passt nicht mehr zum angefragten.',
    code: `// ein Byte im übertragenen Chunk wird auf dem Transportweg verändert
await xferBob.requestFile(manifestId);
// → wirft: Chunk hash mismatch — rejected, not stored`,
    kind: 'error',
    expectFailure: true,
    async run(ctx) {
      const { a: chFA, b: chFB } = createLoopbackChannelPair();
      const corrupting = {
        ...chFA,
        send: (msg) => {
          if (msg.type === 'qu.file.chunk.response' && msg.bytes) {
            const bytes = Uint8Array.from(atob(msg.bytes), (c) => c.charCodeAt(0));
            bytes[0] ^= 0xff;
            msg = { ...msg, bytes: btoa(String.fromCharCode(...bytes)) };
          }
          return chFA.send(msg);
        },
      };
      const freshBobFiles = new MemoryFileStorageAdapter();
      const xferAlice = ctx.alice.fileTransfer(corrupting, ctx.aliceFiles);
      const xferBob = ctx.bob.fileTransfer(chFB, freshBobFiles);
      try {
        await xferBob.requestFile(ctx.fileManifestId);
      } finally {
        xferAlice.close();
        xferBob.close();
      }
      return {};
    },
  },
];
