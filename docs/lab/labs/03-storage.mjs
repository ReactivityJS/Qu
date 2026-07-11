// Lab 3: Storage-Adapter laden und nutzen — jeder Adapter exerciert exakt
// denselben StorageAdapter-Contract (core/storage.js), damit ein
// get/put/getAll/delete-Roundtrip 1:1 vergleichbar ist. LocalStorage/
// SessionStorage/IndexedDB sind Browser-only (siehe README "Status") und
// laufen hier zum ersten Mal wirklich, nicht nur `node --check`.
import {
  MemoryAdapter, NullAdapter, LocalStorageAdapter, SessionStorageAdapter, IndexedDBAdapter,
  assertStorageAdapter,
} from '../../../src/index.js';

async function exerciseAdapter(adapter, label) {
  assertStorageAdapter(adapter); // wirft, falls der Adapter den Contract nicht erfüllt
  const prefix = `lab-storage-test/${label}/`;
  const id = `${prefix}${crypto.randomUUID()}`;
  const qubit = { id, value: { hello: label }, ts: Date.now() };

  await adapter.put(id, qubit);
  const got = await adapter.get(id);
  const all = await adapter.getAll(prefix);
  await adapter.delete(id);
  const afterDelete = await adapter.get(id);

  return {
    'get() nach put() liefert denselben Wert': JSON.stringify(got) === JSON.stringify(qubit),
    'getAll(prefix) findet ihn': all.some((q) => q.id === id),
    'get() nach delete() liefert null': afterDelete === null,
  };
}

export const steps = [
  {
    id: 'memory',
    title: '1 · MemoryAdapter (Baseline)',
    description: 'Der Core-Default — reines In-Memory, funktioniert überall (Node + Browser), nichts überlebt einen Reload.',
    code: `const adapter = new MemoryAdapter();
await adapter.put(id, qubit);
await adapter.get(id); // -> qubit`,
    kind: 'info',
    async run() { return exerciseAdapter(new MemoryAdapter(), 'memory'); },
  },
  {
    id: 'localstorage',
    title: '2 · LocalStorageAdapter (echt persistent)',
    description: 'Schreibt wirklich in das localStorage dieses Origins — bleibt über einen Reload hinweg erhalten (siehe Lab 1).',
    code: `const adapter = new LocalStorageAdapter({ namespace: 'lab:' });
await adapter.put(id, qubit); // localStorage.setItem('lab:' + id, ...)`,
    kind: 'info',
    async run() { return exerciseAdapter(new LocalStorageAdapter({ namespace: 'lab-storage-demo:' }), 'localstorage'); },
  },
  {
    id: 'sessionstorage',
    title: '3 · SessionStorageAdapter (Tab-gebunden)',
    description: 'Identischer Contract, aber sessionStorage: weg, sobald dieser Tab geschlossen wird — nicht geteilt mit anderen Tabs desselben Origins.',
    code: `const adapter = new SessionStorageAdapter({ namespace: 'lab:' });`,
    kind: 'info',
    async run() { return exerciseAdapter(new SessionStorageAdapter({ namespace: 'lab-storage-demo:' }), 'sessionstorage'); },
  },
  {
    id: 'indexeddb',
    title: '4 · IndexedDBAdapter (echte Transaktion)',
    description: 'Statt JSON-Strings in einem Key-Value-Store: ein echter IndexedDB-Object-Store, getAll(prefix) über einen Key-Range-Cursor statt vollem Scan.',
    code: `const adapter = new IndexedDBAdapter({ dbName: 'qu-lab' });
await adapter.put(id, qubit); // echte IDB-Transaktion`,
    kind: 'info',
    async run() { return exerciseAdapter(new IndexedDBAdapter({ dbName: 'qu-lab-storage-demo' }), 'indexeddb'); },
  },
  {
    id: 'null',
    title: '5 · NullAdapter (reiner Event-Bus, Sonderfall)',
    description: 'Behält absichtlich nichts — get() liefert immer null, auch direkt nach put(). Für Live-Events/Presence/Signaling, die nie persistiert werden sollen (siehe core/session.js/adapters/null.js).',
    code: `const adapter = new NullAdapter();
await adapter.put(id, qubit);
await adapter.get(id); // -> null, nicht qubit!`,
    kind: 'info',
    async run() {
      const adapter = new NullAdapter();
      assertStorageAdapter(adapter);
      const id = 'lab-storage-test/null/x';
      await adapter.put(id, { id, value: 1, ts: Date.now() });
      const got = await adapter.get(id);
      return { 'get() liefert null (by design)': got === null };
    },
  },
];
