// Beispiel 4 (Oberfläche): siehe ../forum-lib.mjs für die eigentliche
// Logik (Zeit-Sharding) — diese Datei ist nur die dünne UI-Schicht
// darüber, im selben Stil wie examples/cms/app.mjs.

import { createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../../src/index.js';
import { createBoard, addPost, listPosts, onPosts, olderBucket, currentBucket } from '../forum-lib.mjs';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { parseHashRoute, buildHashRoute } from '../space-app-lib.mjs';

const IDENTITY_KEY = 'qu-forum-identity-keys'; // eigener Key, unabhängig von anderen Beispielen

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const shareBox = el('share-box');
const shareLinkEl = el('share-link');
const bucketLabelEl = el('bucket-label');
const olderBtn = el('older-btn');
const newerBtn = el('newer-btn');
const emptyNoticeEl = el('empty-notice');
const postsEl = el('posts');
const postForm = el('post-form');
const postTextInput = el('post-text');

async function main() {
  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  // Einheitliches Adressformat wie jede Space-App (siehe space-app-lib.mjs):
  // `#<boardId>` — ein Board hat keinen weiteren Unterpfad, `path` bleibt hier ungenutzt.
  let { spaceId: boardId } = parseHashRoute(location.hash);

  if (!boardId) {
    // Offenes Board (writers: ['*']) — für die Demo soll jede:r mit dem Link mitposten können, ohne erst Schreibrecht per Fingerprint zu erbitten (vgl. todo-lib.mjs, wo genau das gezeigt wird).
    boardId = await createBoard(qu, { writers: ['*'] });
    location.hash = buildHashRoute(boardId);
  }

  const repl = await qu.connect(channel, { pushTopics: [`${boardId}/`] });
  statusEl.textContent = 'Synchronisiere …';
  // Ein einziger sync() reicht in beide Richtungen (reziprok — siehe
  // APP-GUIDE.md Schritt 5): ein frisch erzeugtes Board PUSHT damit sein
  // Manifest zum Relay (createBoard() lief VOR qu.connect(), pushTopics
  // greift nur für Schreibungen danach), ein Besucher holt sich damit
  // den aktuellen Stand ab.
  await repl.sync({ topic: boardId, since: 0 });
  statusEl.textContent = 'Verbunden';

  shareLinkEl.value = `${location.origin}${location.pathname}${buildHashRoute(boardId)}`;
  shareBox.hidden = false;

  const todayBucket = currentBucket();
  let viewBucket = todayBucket;
  let offPosts = null;

  async function renderBucketBar() {
    bucketLabelEl.textContent = viewBucket;
    newerBtn.disabled = viewBucket === todayBucket;
    olderBtn.disabled = (await olderBucket(qu, boardId, viewBucket)) === null;
  }

  async function renderPosts() {
    offPosts?.();
    postsEl.textContent = '';
    emptyNoticeEl.hidden = true;

    const existing = await listPosts(qu, boardId, viewBucket);
    if (existing.length === 0) emptyNoticeEl.hidden = false;

    offPosts = onPosts(qu, boardId, (q) => {
      emptyNoticeEl.hidden = true;
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.className = 'post-text';
      text.textContent = q.value.text;
      const meta = document.createElement('span');
      meta.className = 'post-meta';
      meta.textContent = `${q.writer.slice(0, 8)}… · ${new Date(q.ts).toLocaleString()}`;
      li.append(text, meta);
      postsEl.appendChild(li);
    }, { bucket: viewBucket });
  }

  async function showBucket(bucket) {
    viewBucket = bucket;
    await renderBucketBar();
    await renderPosts();
  }

  await showBucket(todayBucket);

  olderBtn.addEventListener('click', async () => {
    const older = await olderBucket(qu, boardId, viewBucket);
    if (older) await showBucket(older);
  });

  newerBtn.addEventListener('click', () => showBucket(todayBucket));

  postForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = postTextInput.value.trim();
    if (!text) return;
    await addPost(qu, boardId, text, { bucket: todayBucket });
    postTextInput.value = '';
    if (viewBucket !== todayBucket) await showBucket(todayBucket); // ein neuer Post gehört immer in den aktuellen Monat — dorthin zurückspringen, falls gerade ein älterer betrachtet wird
    else await renderBucketBar(); // "Älterer Monat" kann durch den ersten Post dieses Monats neu verfügbar geworden sein
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
