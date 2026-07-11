// Beispiel 3 (Oberfläche): siehe todo-lib.mjs für die eigentliche Logik —
// diese Datei ist nur die dünne UI-Schicht darüber. Verbindung läuft über
// denselben universellen Relay wie die Chat-Demo (kein eigener Server-Code
// für ToDo-Listen nötig — siehe relay/relay.mjs).

import { Qu, createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../src/index.js';
import { createTodoList, canWrite, grantWriteAccess, addItem, setItemDone, deleteItem, listItems, onItemsChange } from './todo-lib.mjs';

const IDENTITY_KEY = 'qu-todo-identity-keys'; // eigener Key, unabhängig von der Chat-Demo — jedes Beispiel ist für sich verständlich

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const shareLinkEl = el('share-link');
const grantForm = el('grant-form');
const grantInput = el('grant-fp');
const writersEl = el('writers');
const readonlyNoticeEl = el('readonly-notice');
const itemsEl = el('items');
const addForm = el('add-form');
const addInput = el('add-text');

async function loadOrCreateIdentity() {
  const saved = localStorage.getItem(IDENTITY_KEY);
  if (saved) return Qu.create({ identity: JSON.parse(saved) });
  const qu = await Qu.create();
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(await qu.exportKeys()));
  return qu;
}

function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/relay`;
}

async function main() {
  // Bewusst kein Reconnect-Handling hier (siehe demo/live-chat.mjs für
  // die vollständige Version mit Backoff + visibilitychange) — dieses
  // Beispiel zeigt Space + ACL + Teilen, nicht Verbindungs-Robustheit.
  const qu = (await loadOrCreateIdentity()).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  const params = new URLSearchParams(location.search);
  let listId = params.get('list');
  const isOwner = !listId;

  if (isOwner) {
    // Kein "?list="-Parameter -> neue Liste anlegen, den eigenen
    // Fingerprint direkt als (einzigen) Writer eintragen.
    listId = await createTodoList(qu);
    history.replaceState(null, '', `?list=${listId}`);
  }

  const repl = await qu.connect(channel, { pushTopics: [`${listId}/`] });

  if (!isOwner) {
    // Der Link enthält nur die Space-ID — der eigene Fingerprint kommt erst
    // hier dazu. readers: ['*'] heißt: Lesen funktioniert immer, unabhängig
    // vom Schreibrecht.
    statusEl.textContent = 'Verbinde …';
    await repl.sync({ topic: listId, since: 0 });
  }
  statusEl.textContent = 'Verbunden';

  shareLinkEl.value = location.href;
  shareLinkEl.parentElement.hidden = false;

  async function refreshPermissions() {
    const allowed = await canWrite(qu, listId);
    addForm.hidden = !allowed;
    readonlyNoticeEl.hidden = allowed;

    const manifest = await qu.get(listId);
    writersEl.textContent = (manifest?.value.writers ?? []).map((fp) => (fp === qu.fingerprint ? `${fp.slice(0, 10)}… (du)` : `${fp.slice(0, 10)}…`)).join(', ');

    // Nur der/die Admin(s) dürfen überhaupt Schreibrechte vergeben — bei
    // allen anderen bleibt das Formular versteckt, nicht nur deaktiviert.
    const isAdmin = manifest?.value.admins?.includes(qu.fingerprint);
    grantForm.hidden = !isAdmin;
  }

  async function renderItems() {
    itemsEl.textContent = '';
    for (const item of await listItems(qu, listId)) {
      const li = document.createElement('li');
      li.className = item.value.done ? 'done' : '';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = item.value.done;
      checkbox.addEventListener('change', () => setItemDone(qu, item.id, checkbox.checked));

      const text = document.createElement('span');
      text.textContent = item.value.text;

      const meta = document.createElement('span');
      meta.className = 'item-meta';
      meta.textContent = `von ${item.writer.slice(0, 8)}…`;

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '✕';
      del.addEventListener('click', () => deleteItem(qu, item.id));

      li.append(checkbox, text, meta, del);
      itemsEl.appendChild(li);
    }
  }

  await refreshPermissions();
  await renderItems();
  onItemsChange(qu, listId, () => renderItems());

  grantForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fp = grantInput.value.trim();
    if (!fp) return;
    await grantWriteAccess(qu, listId, fp);
    grantInput.value = '';
    await refreshPermissions();
  });

  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = addInput.value.trim();
    if (!text) return;
    await addItem(qu, listId, text);
    addInput.value = '';
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
