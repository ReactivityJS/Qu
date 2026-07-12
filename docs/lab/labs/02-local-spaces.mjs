// Lab 2: Spaces & Mehrbenutzer-ACL — mehrere lokale Identitäten auf
// derselben Runtime (kein Netzwerk nötig dafür: zwei "Geräte" im selben
// Tab, wie mehrere eingeloggte User auf einem Server-Prozess), und die
// Kernaussage aus core/identity-acl.js in Aktion: ohne Plugin ist nur der
// eigene User-Space beschreibbar; createSpace()/geteilte Räume brauchen
// explizit createSpacesPlugin(). Spiegelt test/spaces.test.mjs und
// test/qu.test.mjs' createSpace()-Szenarien.
import { Qu, MemoryAdapter, QuStore, createSpacesPlugin } from '../../../src/index.js';

function makeSharedStore() {
  return new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
}

export const steps = [
  {
    id: 'strict-default',
    title: '1 · Ohne Plugin: nur der eigene User-Space ist beschreibbar',
    description: 'core/identity-acl.js ist der Core-Default — strukturell aus der Identität ableitbar, kein Manifest, kein Storage-Roundtrip. Ein generischer (Nicht-User-)Pfad wird abgelehnt.',
    code: `const qu = await Qu.create();
await qu.own.get('ok').put(1);                    // geht
await qu.get('irgendein/generischer/pfad').put(1);  // wirft [ACL] Write denied`,
    kind: 'error',
    expectFailure: true,
    async run(ctx) {
      ctx.solo = await Qu.create();
      await ctx.solo.own.get('ok').put(1);
      await ctx.solo.get('irgendein/generischer/pfad').put(1);
      return {};
    },
  },
  {
    id: 'two-local-users',
    title: '2 · Zwei lokale User, eine geteilte Runtime',
    description: 'owner und bob sind zwei unabhängige Identitäten (eigene Schlüsselpaare), teilen sich aber dieselbe Runtime/denselben Store — wie zwei eingeloggte Nutzer auf einem Server-Prozess, kein Netzwerk beteiligt.',
    code: `const store = new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]);
const owner = (await Qu.create({ store })).use(createSpacesPlugin());
const bob = await Qu.create({ runtime: owner.runtime });`,
    kind: 'info',
    async run(ctx) {
      ctx.store = makeSharedStore();
      ctx.owner = (await Qu.create({ store: ctx.store })).use(createSpacesPlugin());
      ctx.bob = await Qu.create({ runtime: ctx.owner.runtime });
      window.owner = ctx.owner;
      window.bob = ctx.bob;
      return { 'owner.fingerprint': ctx.owner.fingerprint, 'bob.fingerprint': ctx.bob.fingerprint };
    },
  },
  {
    id: 'create-space',
    title: '3 · Space anlegen (createSpacesPlugin macht das möglich)',
    description: 'createSpace() existiert erst, seit owner sich das Spaces-Plugin geholt hat. Das ist eine reine Sugar-Methode auf DIESER Qu-Instanz — bob müsste use() selbst aufrufen, um auch ein eigenes bob.createSpace() zu bekommen. Was dagegen wirklich runtime-weit gilt (setACLResolver()): die ACL-POLICY selbst — genau das sehen die nächsten Schritte, wenn bob ganz ohne eigenes use() erfolgreich in owners Space schreiben darf, sobald er berechtigt ist. createSpace() ist synchron (wie get()) und liefert den Node sofort; das Manifest wird im Hintergrund geschrieben — room.ready ist das Promise DIESES Writes (ein bloßes "await room" wäre nur ein Read und könnte dem Write vorauslaufen).',
    code: `const room = owner.createSpace({ writers: [owner.fingerprint], readers: ['*'] });
await room.ready; // wirklich auf das Manifest warten`,
    kind: 'info',
    async run(ctx) {
      ctx.room = ctx.owner.createSpace({ writers: [ctx.owner.fingerprint], readers: ['*'] });
      await ctx.room.ready;
      return {
        'Space-ID': ctx.room.id,
        'bob.createSpace existiert (Sugar ist pro Instanz, NICHT runtime-weit)': typeof ctx.bob.createSpace === 'function',
      };
    },
  },
  {
    id: 'bob-denied',
    title: '4 · Bob schreibt ohne Rechte — abgelehnt',
    description: 'bob steht noch nicht in den writers des Manifests — die ACL-Middleware lehnt ab, bevor irgendetwas gespeichert wird.',
    code: `await bob.get(room.id).get('msg1').put('bob versucht zu schreiben'); // wirft [ACL] Write denied`,
    kind: 'error',
    expectFailure: true,
    async run(ctx) {
      await ctx.bob.get(ctx.room.id).get('msg1').put('bob versucht zu schreiben');
      return {};
    },
  },
  {
    id: 'grant-access',
    title: '5 · Schreibrecht gewähren',
    description: 'Das Manifest ist selbst nur ein QuBit — owner (Admin) republiziert es mit bob zusätzlich in writers.',
    code: `const manifest = await room;
await room.put({ ...manifest.value, writers: [...manifest.value.writers, bob.fingerprint] });`,
    kind: 'info',
    async run(ctx) {
      const manifest = await ctx.room;
      await ctx.room.put({ ...manifest.value, writers: [...manifest.value.writers, ctx.bob.fingerprint] });
      const updated = await ctx.room;
      return { writers: updated.value.writers.join(', ') };
    },
  },
  {
    id: 'bob-allowed',
    title: '6 · Bob schreibt jetzt erfolgreich',
    description: 'Dieselbe ACL-Middleware, dieselbe Prüfung — nur die Manifest-Daten haben sich geändert.',
    code: `await bob.get(room.id).get('msg1').put('jetzt klappt es');
const view = await owner.session.query(\`\${room.id}/**\`);`,
    kind: 'info',
    async run(ctx) {
      await ctx.bob.get(ctx.room.id).get('msg1').put('jetzt klappt es');
      const view = await ctx.owner.session.query(`${ctx.room.id}/**`);
      return { 'Nachrichten im Space': view.length, Inhalt: view[0]?.value };
    },
  },
];
