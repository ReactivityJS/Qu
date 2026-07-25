// Beispiel 4 (Oberfläche): siehe ../forum-lib.mjs für die eigentliche
// Logik (Zeit-Sharding, Topics/Replies) — diese Datei ist nur die dünne
// UI-Schicht darüber, im selben Stil wie examples/cms/app.mjs.

import { createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../../src/index.js';
import { createBoard, createTopic, listPosts, onPosts, olderBucket, currentBucket, addReply, listReplies, onReplies } from '../forum-lib.mjs';
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
const postTitleInput = el('post-title');
const postTextInput = el('post-text');

const boardViewEl = el('board-view');
const threadViewEl = el('thread-view');
const backToBoardBtn = el('back-to-board-btn');
const threadTitleEl = el('thread-title');
const threadMetaEl = el('thread-meta');
const threadBodyEl = el('thread-body');
const repliesEl = el('replies');
const replyForm = el('reply-form');
const replyTextInput = el('reply-text');

function fmtMeta(q) {
  return `${q.writer.slice(0, 8)}… · ${new Date(q.ts).toLocaleString()}`;
}

async function main() {
  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  // Einheitliches Adressformat wie jede Space-App (siehe space-app-lib.mjs):
  // `#<boardId>` — ein Board hat keinen weiteren Unterpfad, `path` bleibt hier ungenutzt.
  // Welches Topic gerade offen ist, lebt bewusst NUR im Browser-Zustand
  // unten (nicht im Hash) — eine Topic-Id ist bereits ein voller Pfad
  // (`<boardId>/posts/<bucket>/<fp>-<ts>`, siehe forum-lib.mjs's
  // createTopic()-Doku) und würde parseHashRoute()s "ein Segment = eine
  // Id"-Annahme verletzen.
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
      const title = document.createElement('span');
      title.className = 'post-title';
      title.textContent = q.value.title;
      const text = document.createElement('span');
      text.className = 'post-text';
      text.textContent = q.value.text;
      const meta = document.createElement('span');
      meta.className = 'post-meta';
      meta.textContent = fmtMeta(q);
      li.append(title, text, meta);
      li.addEventListener('click', () => openTopic(q));
      postsEl.appendChild(li);
    }, { bucket: viewBucket });
  }

  async function showBucket(bucket) {
    viewBucket = bucket;
    await renderBucketBar();
    await renderPosts();
  }

  // --- Thread-Ansicht: EIN Topic mit seinen Antworten ---
  let offReplies = null;

  async function openTopic(topic) {
    boardViewEl.classList.add('hidden');
    threadViewEl.classList.remove('hidden');
    threadTitleEl.textContent = topic.value.title;
    threadMetaEl.textContent = fmtMeta(topic);
    threadBodyEl.textContent = topic.value.text;

    offReplies?.();
    repliesEl.textContent = '';
    offReplies = onReplies(qu, topic.id, (q) => {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.className = 'post-text';
      text.textContent = q.value.text;
      const meta = document.createElement('span');
      meta.className = 'post-meta';
      meta.textContent = fmtMeta(q);
      li.append(text, meta);
      repliesEl.appendChild(li);
    });
    await listReplies(qu, topic.id); // nur um denselben Query-Pfad einmal warmzuziehen, das eigentliche Rendern übernimmt onReplies()' initial:true oben

    replyForm.dataset.topicId = topic.id;
  }

  function closeThread() {
    offReplies?.();
    offReplies = null;
    threadViewEl.classList.add('hidden');
    boardViewEl.classList.remove('hidden');
  }

  backToBoardBtn.addEventListener('click', closeThread);

  replyForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = replyTextInput.value.trim();
    const topicId = replyForm.dataset.topicId;
    if (!text || !topicId) return;
    await addReply(qu, topicId, text);
    replyTextInput.value = '';
  });

  await showBucket(todayBucket);

  olderBtn.addEventListener('click', async () => {
    const older = await olderBucket(qu, boardId, viewBucket);
    if (older) await showBucket(older);
  });

  newerBtn.addEventListener('click', () => showBucket(todayBucket));

  postForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const title = postTitleInput.value.trim();
    const text = postTextInput.value.trim();
    if (!title || !text) return;
    await createTopic(qu, boardId, { title, text }, { bucket: todayBucket });
    postTitleInput.value = '';
    postTextInput.value = '';
    if (viewBucket !== todayBucket) await showBucket(todayBucket); // ein neues Topic gehört immer in den aktuellen Monat — dorthin zurückspringen, falls gerade ein älterer betrachtet wird
    else await renderBucketBar(); // "Älterer Monat" kann durch das erste Topic dieses Monats neu verfügbar geworden sein
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
