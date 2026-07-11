// Lab 5: Referenzen in der Praxis — eine kleine Kontakt-/Dateibibliothek,
// die alle drei Referenz-Schemata an echten Daten zeigt:
//   - obj://<prefix>  sammelt die Einträge zu einer Liste
//   - key://<id>       jeder Eintrag verweist auf eine Kategorie-QuBit
//   - file://<id>       jeder Eintrag kann einen echten Datei-Upload referenzieren
//
// Die Liste UND die Notiz je Eintrag sind echte Live-Ansichten, kein
// Snapshot nach einem Klick — und zeigen bewusst BEIDE Ebenen der UI-Schicht
// nebeneinander, jede dort, wo sie das richtige Werkzeug ist:
//   - viewObject() (src/ui/bindings.js, JS) für die Liste — Aufzählen von
//     Kind-QuBits unter einem Prefix hat keine deklarative Entsprechung
//     (bewusst: siehe Doku-Kommentar in ui/components.js), bleibt also JS.
//   - <qu-bind> (src/ui/components.js, Custom Element) für die Notiz je
//     Eintrag — eine einzelne Leaf-QuBit (`${entryId}/note`), genau der
//     Fall, für den die Komponente gebaut ist: `path`+`key` statt einem
//     manuellen bindKey()-Aufruf, disconnectedCallback() räumt beim
//     Entfernen aus dem DOM automatisch auf (kein von Hand verwaltetes
//     off() pro Eintrag mehr nötig).
// Derselbe Echo-Schutz gilt in beiden Fällen (id+ts statt Wert-Vergleich
// beim Rendern, Wert-Vergleich vor dem Schreiben) — <qu-bind> ruft dieselbe
// bindKey()-Funktion nur aus einem connectedCallback() statt von Hand auf.
// Es gibt an keiner Stelle einen "Neu laden"-Aufruf.
import {
  Qu, MemoryFileStorageAdapter, createReferenceHandlerPlugin, createFileHandlerPlugin,
  objRef, keyRef, resolveReference, viewObject,
} from '../../../src/index.js';
import '../../../src/ui/components.js';
import { el } from '../render.mjs';

const CATEGORIES = [
  { id: 'work', label: 'Arbeit' },
  { id: 'personal', label: 'Privat' },
];

export const steps = [
  {
    id: 'setup',
    title: '1 · Qu anlegen, ReferenceHandler + FileHandler installieren',
    description: 'Beide Plugins sind unabhängig voneinander optional — hier zusammen, weil file:// erst mit einem FileHandler zu echten Bytes statt zum rohen Manifest auflöst (siehe resolveReference-Doku in references.js).',
    code: `const fileStorage = new MemoryFileStorageAdapter();
const fileHandler = createFileHandlerPlugin({ fileStorage });
const qu = (await Qu.create())
  .use(fileHandler)
  .use(createReferenceHandlerPlugin({ maxDepth: 1, fileHandler }));`,
    kind: 'info',
    async run(ctx) {
      ctx.fileStorage = new MemoryFileStorageAdapter();
      ctx.fileHandler = createFileHandlerPlugin({ fileStorage: ctx.fileStorage });
      ctx.qu = (await Qu.create()).use(ctx.fileHandler).use(createReferenceHandlerPlugin({ maxDepth: 1, fileHandler: ctx.fileHandler }));
      ctx.base = ctx.qu.userSpaceId;
      window.qu = ctx.qu;
      return { Fingerprint: ctx.qu.fingerprint, 'User-Space (alles lebt darunter)': ctx.base };
    },
  },
  {
    id: 'categories',
    title: '2 · Kategorien anlegen (Ziele für key://)',
    description: 'Zwei feste QuBits, auf die Einträge später per key:// verweisen — genau wie ein Foreign Key auf eine kleine Lookup-Tabelle.',
    code: `await qu.publish(\`\${base}/categories/work\`, { label: 'Arbeit' });
await qu.publish(\`\${base}/categories/personal\`, { label: 'Privat' });`,
    kind: 'info',
    async run(ctx) {
      for (const cat of CATEGORIES) {
        await ctx.qu.publish(`${ctx.base}/categories/${cat.id}`, { label: cat.label });
      }
      return { Kategorien: CATEGORIES.map((c) => c.label).join(', ') };
    },
  },
  {
    id: 'seed-entry',
    title: '3 · Einen ersten Eintrag anlegen (vor der Live-Ansicht)',
    description: 'Absichtlich VOR dem Mounten der Live-Ansicht unten geschrieben — zeigt, dass initial:true bestehende Daten genauso liefert wie künftige. Die Live-Ansicht unten zeigt diesen Eintrag, ohne dass sie je explizit danach gefragt hat.',
    code: `const id = crypto.randomUUID();
await qu.publish(\`\${base}/entries/\${id}\`, {
  name: 'Erster Eintrag (vor der Live-Ansicht angelegt)',
  category: keyRef(\`\${base}/categories/work\`),
  avatar: null,
  createdAt: Date.now(),
});`,
    kind: 'info',
    async run(ctx) {
      const id = crypto.randomUUID();
      await ctx.qu.publish(`${ctx.base}/entries/${id}`, {
        name: 'Erster Eintrag (vor der Live-Ansicht angelegt)',
        category: keyRef(`${ctx.base}/categories/work`),
        avatar: null,
        createdAt: Date.now(),
      });
      return { 'Eintrags-ID': id };
    },
  },
  {
    id: 'one-shot-snapshot',
    title: '4 · Zum Vergleich: eine einmalige Momentaufnahme (nicht reaktiv)',
    description: 'resolveReference() mit obj:// liefert genau EINMAL den aktuellen Stand — nützlich, wenn eine App wirklich nur einen Snapshot braucht. Die Live-Ansicht unten macht das NICHT so: sie nutzt viewObject()/bindKey() (src/ui/bindings.js) und bleibt danach dauerhaft aktuell.',
    code: `const snapshot = await resolveReference(qu, objRef(\`\${base}/entries\`), { asArray: true });`,
    kind: 'info',
    async run(ctx) {
      const snapshot = await resolveReference(ctx.qu, objRef(`${ctx.base}/entries`), { asArray: true });
      return { 'Einträge im Snapshot': snapshot.length, Hinweis: 'ab hier reaktiv weiter unten, nicht mehr per Klick' };
    },
  },
];

function formatCategory(qu, categoryRef, targetEl) {
  if (!categoryRef) { targetEl.textContent = '(keine Kategorie)'; return; }
  resolveReference(qu, categoryRef).then((cat) => { targetEl.textContent = cat?.label ?? categoryRef; }).catch(() => { targetEl.textContent = categoryRef; });
}

function renderAvatar(qu, avatarRef, fileHandler, targetEl) {
  if (!avatarRef) { targetEl.textContent = ''; return; }
  targetEl.textContent = 'Datei wird geladen …';
  resolveReference(qu, avatarRef, { fileHandler }).then((bytes) => {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    targetEl.textContent = '';
    const link = el('a', { class: 'lib-file-link', href: url, download: 'datei', text: '📎 Datei herunterladen' });
    targetEl.appendChild(link);
  }).catch((e) => { targetEl.textContent = `Datei nicht verfügbar: ${e.message}`; });
}

/**
 * Die reaktive Live-Ansicht: Formular (Name + Kategorie + optionale Datei)
 * schreibt neue Einträge; die Liste selbst wird NIE manuell neu geladen —
 * jede Änderung kommt ausschließlich über viewObject()s eine Subscription
 * herein. Jeder Eintrag bekommt außerdem ein zweiseitig gebundenes
 * Notiz-Feld (<qu-bind>) — als eigene Leaf-QuBit unter dem Eintrag, tippen
 * schreibt sofort, kein Speichern-Knopf, und die Änderung eines zweiten
 * Tabs/Fensters auf demselben Eintrag würde hier genauso ankommen wie ein
 * frischer Eintrag.
 */
export function mountLibraryView(container, ctx) {
  const { qu, base, fileStorage, fileHandler } = ctx;
  // Muss VOR jedem angehängten <qu-bind>-Nachfahren gesetzt sein —
  // appendChild() löst connectedCallback() synchron aus, das dort per
  // DOM-Walk nach der nächsten .qu-Property sucht (siehe ui/components.js).
  container.qu = qu;

  container.appendChild(el('h3', { text: 'Live-Bibliothek (reaktiv, kein Refresh-Button)' }));

  const form = el('form', { class: 'lib-form' });
  const nameInput = el('input', { type: 'text', placeholder: 'Name', required: 'required', class: 'lib-input' });
  const categorySelect = el('select', { class: 'lib-input' }, CATEGORIES.map((c) => el('option', { value: c.id, text: c.label })));
  const fileInput = el('input', { type: 'file', class: 'lib-input' });
  const submitBtn = el('button', { type: 'submit', class: 'run-btn', text: '+ Eintrag anlegen' });
  form.append(nameInput, categorySelect, fileInput, submitBtn);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!nameInput.value.trim()) return;
    submitBtn.disabled = true;
    try {
      const id = crypto.randomUUID();
      let avatar = null;
      const file = fileInput.files[0];
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { fileRef } = await qu.shareFile(`${base}/files/${id}`, bytes, { name: file.name, mime: file.type, fileStorage });
        avatar = fileRef;
      }
      await qu.publish(`${base}/entries/${id}`, {
        name: nameInput.value.trim(),
        category: keyRef(`${base}/categories/${categorySelect.value}`),
        avatar,
        createdAt: Date.now(),
      });
      nameInput.value = '';
      fileInput.value = '';
      // Kein manuelles Nachladen der Liste hier — viewObject() unten
      // erhält genau dieses publish() von selbst.
    } finally {
      submitBtn.disabled = false;
    }
  });

  const list = el('ul', { class: 'lib-list' });
  const empty = el('p', { class: 'step-desc', text: 'Noch keine Einträge — leg den ersten über das Formular an.' });
  container.append(form, empty, list);

  const offView = viewObject(qu, `${base}/entries`, {
    createItem(q) {
      empty.hidden = true;
      const li = el('li', { class: 'lib-entry' });
      const nameEl = el('span', { class: 'lib-name' });
      const metaEl = el('span', { class: 'lib-meta' });
      const fileAreaEl = el('div', { class: 'lib-file-area' });
      const noteInput = el('textarea', {
        class: 'lib-note', rows: '2',
        placeholder: 'Live-Notiz zu diesem Eintrag — direkt tippen, kein Speichern-Knopf',
      });
      // <qu-bind> statt eines manuellen bindKey()-Aufrufs: path=q.id,
      // key="note" -> eigene Leaf-QuBit `${q.id}/note`, unabhängig vom
      // Render-Zyklus der Liste selbst (kein Feld des Eintrags-Objekts).
      // Das eingewickelte <textarea> wird automatisch zum Bind-Ziel (siehe
      // "Target element" in ui/components.js) — Vorteil gegenüber dem
      // vorherigen bindKey()-Aufruf: disconnectedCallback() räumt beim
      // Entfernen aus dem DOM selbst auf, kein von Hand verwaltetes off().
      const noteBind = el('qu-bind', { path: q.id, key: 'note' }, [noteInput]);
      li.append(nameEl, metaEl, fileAreaEl, noteBind);
      list.appendChild(li);
      return { nameEl, metaEl, fileAreaEl };
    },
    render(item, value) {
      item.nameEl.textContent = value.name;
      formatCategory(qu, value.category, item.metaEl);
      renderAvatar(qu, value.avatar, fileHandler, item.fileAreaEl);
    },
  });

  return () => { offView(); };
}
