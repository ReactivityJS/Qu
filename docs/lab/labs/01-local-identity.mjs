// Lab 1: Identität lokal/offline — anlegen, in localStorage speichern,
// wieder laden, und die zwei unterschiedlichen "Lösch"-Operationen, die in
// jeder echten lokalen App gebraucht werden: Nutzdaten zurücksetzen (die
// Identität bleibt) vs. den Nutzer selbst löschen (das Schlüsselpaar ist
// weg — ohne Backup unwiederbringlich, exakt wie bei einer echten
// Ende-zu-Ende-verschlüsselten App).
//
// Nutzt einen echten LocalStorageAdapter für die QuBits, nicht den
// MemoryAdapter — der Punkt dieses Labs ist "läuft wirklich in diesem
// Browser-Tab über einen Reload hinweg", nicht nur "läuft".
import { Qu, QuStore, LocalStorageAdapter } from '../../../src/index.js';

const IDENTITY_KEY = 'qu-lab-identity';
const DATA_NAMESPACE = 'qu-lab-data:';

export function makeLabStore() {
  const adapter = new LocalStorageAdapter({ namespace: DATA_NAMESPACE });
  return { adapter, store: new QuStore([{ prefix: '', adapter }]) };
}

export const steps = [
  {
    id: 'create-user',
    title: '1 · User anlegen',
    description: 'Qu.create() erzeugt eine neue Identität (ECDSA-Signierschlüssel + ECDH-Verschlüsselungsschlüssel) und verbindet sie mit einem QuStore, der echt in localStorage schreibt.',
    code: `const { store } = makeLabStore(); // LocalStorageAdapter, Namespace 'qu-lab-data:'
const qu = await Qu.create({ store });
console.log(qu.fingerprint, qu.userSpaceId);`,
    kind: 'info',
    async run(ctx) {
      const { adapter, store } = makeLabStore();
      ctx.adapter = adapter;
      ctx.store = store;
      ctx.qu = await Qu.create({ store });
      window.qu = ctx.qu; // console: qu.fingerprint, await qu.publish(...), ...
      return { Fingerprint: ctx.qu.fingerprint, 'User-Space': ctx.qu.userSpaceId };
    },
  },
  {
    id: 'save-identity',
    title: '2 · Identität in localStorage speichern',
    description: 'exportKeys() liefert die vier JWK-Schlüssel — genug, um dieselbe Identität später exakt wiederherzustellen (gleicher Fingerprint), z.B. nach einem Seitenreload.',
    code: `localStorage.setItem('qu-lab-identity', JSON.stringify(await qu.exportKeys()));`,
    kind: 'info',
    async run(ctx) {
      const keys = await ctx.qu.exportKeys();
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(keys));
      return { 'localStorage-Key': IDENTITY_KEY, 'Gespeicherte Bytes': localStorage.getItem(IDENTITY_KEY).length };
    },
  },
  {
    id: 'load-identity',
    title: '3 · Identität aus localStorage laden (neue Session)',
    description: 'Simuliert einen Reload: eine komplett neue Qu-Instanz, aber mit den importierten Schlüsseln — derselbe Fingerprint, derselbe User-Space.',
    code: `const saved = JSON.parse(localStorage.getItem('qu-lab-identity'));
const { store } = makeLabStore(); // derselbe Namespace -> dieselben Daten
const qu2 = await Qu.create({ identity: saved, store });`,
    kind: 'info',
    async run(ctx) {
      const saved = JSON.parse(localStorage.getItem(IDENTITY_KEY));
      if (!saved) throw new Error('Kein gespeicherter Schlüssel — erst Schritt 2 ausführen');
      const { store } = makeLabStore();
      const qu2 = await Qu.create({ identity: saved, store });
      return { 'Fingerprint stimmt mit Schritt 1 überein': qu2.fingerprint === ctx.qu.fingerprint, Fingerprint: qu2.fingerprint };
    },
  },
  {
    id: 'write-some-data',
    title: '4 · Etwas schreiben',
    description: 'Ein QuBit unter dem eigenen User-Space — Core-Default, kein Plugin nötig (core/identity-acl.js erlaubt das immer).',
    code: `await qu.publish(\`\${qu.userSpaceId}/note\`, { text: 'Hallo aus localStorage' });`,
    kind: 'info',
    async run(ctx) {
      await ctx.qu.publish(`${ctx.qu.userSpaceId}/note`, { text: 'Hallo aus localStorage' });
      const rows = await ctx.store.query(ctx.qu.userSpaceId);
      return { 'QuBits im Store (dieser User)': rows.length };
    },
  },
  {
    id: 'delete-user-data',
    title: '5 · User-Daten löschen (NICHT den User)',
    description: 'Löscht gezielt jedes QuBit unter diesem User-Space aus dem Adapter — die Identität (Schlüsselpaar in localStorage) bleibt unangetastet. Genau die Unterscheidung zwischen "Daten zurücksetzen" und "Account löschen".',
    code: `const rows = await store.query(qu.userSpaceId);
for (const row of rows) await adapter.delete(row.id);
// localStorage.getItem('qu-lab-identity') ist weiterhin da`,
    kind: 'info',
    async run(ctx) {
      const rows = await ctx.store.query(ctx.qu.userSpaceId);
      for (const row of rows) await ctx.adapter.delete(row.id);
      const remaining = await ctx.store.query(ctx.qu.userSpaceId);
      return {
        'QuBits gelöscht': rows.length,
        'QuBits übrig': remaining.length,
        'Identität noch in localStorage': localStorage.getItem(IDENTITY_KEY) !== null,
      };
    },
  },
  {
    id: 'delete-user',
    title: '6 · User löschen (Schlüsselpaar entfernen)',
    description: 'Entfernt das Schlüsselpaar selbst aus localStorage. Ohne separates Backup der exportierten Keys ist dieser Fingerprint ab jetzt unwiederbringlich — genau wie bei einer echten Ende-zu-Ende-verschlüsselten App: der Anbieter kann den Account nicht "zurücksetzen", weil er den privaten Schlüssel nie hatte.',
    code: `localStorage.removeItem('qu-lab-identity');
// Ein neues Qu.create() ab hier erzeugt einen KOMPLETT ANDEREN Fingerprint.`,
    kind: 'error',
    async run(ctx) {
      localStorage.removeItem(IDENTITY_KEY);
      const freshIdentity = await Qu.create();
      return {
        'Alter Fingerprint': ctx.qu.fingerprint,
        'localStorage-Key jetzt leer': localStorage.getItem(IDENTITY_KEY) === null,
        'Neuer Qu.create() erzeugt anderen Fingerprint': freshIdentity.fingerprint !== ctx.qu.fingerprint,
      };
    },
  },
];
