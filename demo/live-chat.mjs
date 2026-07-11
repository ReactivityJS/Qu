import { Qu, createWebSocketChannel, MemoryFileStorageAdapter, reassembleFile, onDebug, createNetworkPlugin, createFileHandlerPlugin } from '../src/index.js';
import {
  sendMessage, listMessages, onMessage, createChatRoom,
  markRead, getReadReceipts, onReadReceipt,
  getPresence, onPresenceChange, startHeartbeat,
} from '../src/modules/chat.js';

const ROOM_ID = 'qu-demo-room'; // fixed, unmanifested (permanently bootstrap-open) — a real app would discover/create rooms instead
const IDENTITY_KEY = 'qu-demo-identity-keys';
const ALIAS_KEY = 'qu-demo-alias';

const el = (id) => document.getElementById(id);
const messagesEl = el('messages');
const presenceEl = el('presence');
const form = el('composer');
const textInput = el('text-input');
const fileInput = el('file-input');
const statusEl = el('status');
const aliasLabel = el('my-alias');
const debugLogEl = el('debug-log');
const debugCountEl = el('debug-count');
const debugPauseEl = el('debug-pause');
const debugClearEl = el('debug-clear');

// Debug output: on by default (?debug=0 to turn it off), same event shape
// as the relay's console output — one listener, feeds both the browser
// console and this on-page panel, so two windows side by side both show
// what's actually happening without needing devtools open on each.
let debugCount = 0;
if (new URLSearchParams(location.search).get('debug') !== '0') {
  onDebug((entry) => {
    debugCount++;
    debugCountEl.textContent = String(debugCount);
    const isError = entry.event.includes('error') || entry.event.includes('rejected') || entry.event.includes('failed');
    (isError ? console.error : console.log)(`[${entry.scope}:${entry.event}]`, entry.data ?? '');
    if (debugPauseEl.checked) return;
    const line = document.createElement('span');
    line.className = `dbg-line${isError ? ' dbg-err' : ''}`;
    const time = new Date(entry.ts).toLocaleTimeString([], { hour12: false });
    let dataStr = '';
    try { dataStr = typeof entry.data === 'object' ? JSON.stringify(entry.data) : String(entry.data ?? ''); } catch { dataStr = '(unserializable)'; }
    line.innerHTML = '';
    line.append(`${time} `, Object.assign(document.createElement('span'), { className: 'dbg-scope', textContent: `[${entry.scope}:${entry.event}]` }), ` ${dataStr}`);
    debugLogEl.appendChild(line);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
    while (debugLogEl.children.length > 500) debugLogEl.removeChild(debugLogEl.firstChild); // bounded, this is a live demo panel not a log archive
  });
}
debugClearEl.addEventListener('click', () => { debugLogEl.textContent = ''; debugCount = 0; debugCountEl.textContent = '0'; });

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function shortFp(fp) {
  return fp ? `${fp.slice(0, 6)}…` : '(unbekannt)';
}

async function loadOrCreateIdentity() {
  const saved = localStorage.getItem(IDENTITY_KEY);
  if (saved) return Qu.create({ identity: JSON.parse(saved) });
  const qu = await Qu.create();
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(await qu.exportKeys()));
  return qu;
}

async function ensureAlias(qu) {
  let alias = localStorage.getItem(ALIAS_KEY);
  if (!alias) {
    alias = prompt('Dein Anzeigename für den Demo-Chat:', `Gast-${qu.fingerprint.slice(0, 4)}`) || `Gast-${qu.fingerprint.slice(0, 4)}`;
    localStorage.setItem(ALIAS_KEY, alias);
  }
  await qu.publishProfile({ alias, epub: (await qu.exportKeys()).encPub });
  return alias;
}

function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/relay`;
}

async function main() {
  statusEl.textContent = 'Verbinde …';
  const qu = await loadOrCreateIdentity();
  const alias = await ensureAlias(qu);
  aliasLabel.textContent = `${alias} (${shortFp(qu.fingerprint)})`;

  const aliasCache = new Map([[qu.fingerprint, alias]]); // fingerprint -> alias, filled in as profiles are seen
  const localFileStorage = new MemoryFileStorageAdapter();
  qu.use(createNetworkPlugin());
  qu.use(createFileHandlerPlugin({ fileStorage: localFileStorage }));

  // Mobile browsers frequently kill a background WebSocket connection
  // outright when the screen turns off or the tab is backgrounded, to save
  // battery — silently, from the page's point of view. Without this, the
  // page just sits there looking connected while nothing actually flows,
  // until a manual reload. `let`, not `const`: reconnecting replaces these
  // with fresh instances, and every closure below (renderAttachment, the
  // submit handler) references them by name, so a reassignment here is
  // immediately visible everywhere else without re-registering anything.
  let channel;
  let repl;
  let fileTransfer;
  let reconnecting = false;
  let reconnectAttempt = 0;
  let lastSeenTs = 0;

  async function connectToRelay() {
    channel = createWebSocketChannel(relayUrl());
    await channel.connect();
    repl = await qu.connect(channel, { pushTopics: [`${ROOM_ID}/`] });
    fileTransfer = qu.fileTransfer(channel, localFileStorage); // serves chunk requests too — without this, nothing this client uploads could ever be mirrored by the relay
    channel.onClose(() => scheduleReconnect());

    statusEl.textContent = 'Verbunden — hole Verlauf …';
    await repl.sync({ topic: ROOM_ID, since: lastSeenTs }); // only the delta since last time, not the whole room again on every reconnect
    statusEl.textContent = 'Verbunden';
    reconnectAttempt = 0;
  }

  function scheduleReconnect() {
    if (reconnecting) return; // already retrying — don't stack up parallel attempts
    reconnecting = true;
    reconnectAttempt++;
    const delayMs = Math.min(1000 * 2 ** (reconnectAttempt - 1), 15000);
    statusEl.textContent = `Verbindung getrennt — neuer Versuch in ${Math.round(delayMs / 1000)}s …`;
    setTimeout(async () => {
      try {
        await connectToRelay();
      } catch (e) {
        console.error('[live-chat] reconnect attempt failed:', e);
        statusEl.textContent = `Wiederverbindung fehlgeschlagen: ${e.message}`;
      } finally {
        reconnecting = false;
      }
    }, delayMs);
  }

  await connectToRelay();

  // Proactive check, not just reacting to the 'close' event: on some
  // mobile devices the browser doesn't notice (or is slow to notice) that
  // a backgrounded connection died until the page tries to use it again.
  // Waking the screen / returning to the tab is exactly the moment to ask
  // "are we actually still connected?" instead of waiting to find out the
  // hard way on the next send.
  const checkConnectionHealth = () => {
    if (reconnecting) return;
    if (!channel.isOpen()) scheduleReconnect();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkConnectionHealth(); });
  window.addEventListener('focus', checkConnectionHealth);
  window.addEventListener('online', checkConnectionHealth);

  const stopHeartbeat = startHeartbeat(qu, ROOM_ID, { intervalMs: 6000 });
  window.addEventListener('beforeunload', () => { stopHeartbeat(); });

  async function aliasFor(fp) {
    if (aliasCache.has(fp)) return aliasCache.get(fp);
    const p = await qu.get(`~${fp}/alias`);
    const name = p?.value ?? shortFp(fp);
    aliasCache.set(fp, name);
    return name;
  }

  let receipts = {};
  async function refreshReceipts() {
    receipts = await getReadReceipts(qu, ROOM_ID);
    renderReadMarks();
  }

  function renderReadMarks() {
    for (const li of messagesEl.querySelectorAll('[data-ts]')) {
      const ts = Number(li.dataset.ts);
      const readers = Object.entries(receipts).filter(([fp, upTo]) => fp !== li.dataset.writer && upTo >= ts);
      const mark = li.querySelector('.status');
      if (mark) mark.textContent = readers.length ? `gelesen ✓✓` : 'gesendet ✓';
    }
  }

  function renderAttachment(manifestId, manifest) {
    const wrap = document.createElement('div');
    wrap.className = 'attachment';

    const label = document.createElement('span');
    label.textContent = `📎 ${manifest.name} · ${manifest.mime} · ${manifest.chunks.length} Chunk(s)`;
    wrap.appendChild(label);

    const status = document.createElement('span');
    status.className = 'attachment-status';
    status.textContent = 'wird vom Absender übertragen …';
    wrap.appendChild(status);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'attachment-btn';
    btn.textContent = 'Laden';
    btn.hidden = true; // only shown once waitUntilReady() confirms every chunk is actually available
    wrap.appendChild(btn);

    const preview = document.createElement('div');
    preview.className = 'attachment-preview';
    wrap.appendChild(preview);

    async function download() {
      btn.disabled = true;
      btn.textContent = 'Lädt …';
      try {
        await fileTransfer.requestFile(manifestId, {
          onProgress: ({ attempt, maxAttempts }) => { btn.textContent = `Lädt … (${attempt}/${maxAttempts})`; },
        });
        const bytes = await reassembleFile(localFileStorage, manifest);
        const blob = new Blob([bytes], { type: manifest.mime });
        const url = URL.createObjectURL(blob);
        if (manifest.mime.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = url;
          img.className = 'attachment-media';
          preview.appendChild(img);
        } else if (manifest.mime.startsWith('video/')) {
          const video = document.createElement('video');
          video.src = url;
          video.controls = true;
          video.className = 'attachment-media';
          preview.appendChild(video);
        } else {
          const a = document.createElement('a');
          a.href = url;
          a.download = manifest.name;
          a.textContent = `${manifest.name} herunterladen`;
          preview.appendChild(a);
        }
        status.remove();
        btn.remove();
      } catch (e) {
        console.error('[live-chat] attachment download failed:', e);
        btn.textContent = 'Erneut versuchen';
        btn.title = e.message; // full detail on hover, not just in the console
        btn.disabled = false;
      }
    }
    btn.addEventListener('click', download);

    // Background readiness poll — no bytes transferred by this, just "do
    // you have everything yet?". Only once this says yes does the button
    // (a real download) get offered at all, instead of a receiver clicking
    // "Laden" seconds after the file was sent, hitting an avoidable error
    // while the relay is still mirroring it from the sender. If the file is
    // already complete locally (e.g. this is the sender's own upload, or
    // it was already downloaded earlier), skip the network round-trip.
    fileTransfer.hasComplete(manifestId).then((already) => {
      if (already) { status.remove(); btn.hidden = false; return; }
      return fileTransfer.waitUntilReady(manifestId, {
        onProgress: ({ attempt }) => { status.textContent = `wird vom Absender übertragen … (Prüfung ${attempt})`; },
      }).then((ready) => {
        if (ready) {
          status.remove();
          btn.hidden = false;
        } else {
          status.textContent = 'nicht verfügbar (Zeitüberschreitung)';
          btn.hidden = false;
          btn.textContent = 'Trotzdem versuchen';
        }
      });
    });

    return wrap;
  }

  async function renderMessage(q) {
    if (q.ts > lastSeenTs) lastSeenTs = q.ts;
    const mine = q.writer === qu.fingerprint;
    const name = await aliasFor(q.writer);
    const li = document.createElement('li');
    li.className = `msg ${mine ? 'mine' : ''}`;
    li.dataset.ts = q.ts;
    li.dataset.writer = q.writer;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = `${name} · ${fmtTime(q.ts)}`;
    li.appendChild(meta);

    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = q.value.text ?? '';
    li.appendChild(body);

    if (q.refs?.length) {
      for (const refId of q.refs) {
        const manifestQ = await qu.get(refId);
        if (!manifestQ) continue;
        li.appendChild(renderAttachment(refId, manifestQ.value));
      }
    }

    if (mine) {
      const status = document.createElement('div');
      status.className = 'status';
      status.textContent = 'gesendet ✓';
      li.appendChild(status);
    }

    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (document.hasFocus()) {
      await markRead(qu, ROOM_ID, q.ts);
      refreshReceipts();
    }
  }

  function renderPresence(map) {
    presenceEl.textContent = '';
    const entries = Object.entries(map).sort((a, b) => (b[1].online ? 1 : 0) - (a[1].online ? 1 : 0));
    for (const [fp, info] of entries) {
      const li = document.createElement('li');
      li.className = info.online ? 'online' : 'offline';
      aliasFor(fp).then((name) => { li.textContent = `${info.online ? '●' : '○'} ${name}`; });
      presenceEl.appendChild(li);
    }
  }

  for (const q of await listMessages(qu, ROOM_ID)) await renderMessage(q);
  await refreshReceipts();
  renderPresence(await getPresence(qu, ROOM_ID));

  onMessage(qu, ROOM_ID, (q) => { renderMessage(q); });
  onReadReceipt(qu, ROOM_ID, () => { refreshReceipts(); });
  onPresenceChange(qu, ROOM_ID, async () => { renderPresence(await getPresence(qu, ROOM_ID)); });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      const rows = await listMessages(qu, ROOM_ID);
      const last = rows.at(-1);
      if (last) { await markRead(qu, ROOM_ID, last.ts); refreshReceipts(); }
    }
  });

  const sendButton = form.querySelector('button[type="submit"]');
  const offChunking = onDebug((entry) => {
    if (entry.scope !== 'files') return;
    if (entry.event === 'chunking-start') statusEl.textContent = `Datei wird verarbeitet (${entry.data.chunkCount} Chunk${entry.data.chunkCount === 1 ? '' : 's'}) …`;
    if (entry.event === 'chunking-complete') statusEl.textContent = 'Verbunden';
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = textInput.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) return;

    sendButton.disabled = true;
    try {
      let attachments = [];
      if (file) {
        statusEl.textContent = 'Datei wird gelesen …';
        const bytes = new Uint8Array(await file.arrayBuffer());
        attachments = [{ bytes, name: file.name, mime: file.type || 'application/octet-stream', fileStorage: localFileStorage }];
      }
      await sendMessage(qu, ROOM_ID, { text, attachments });
      textInput.value = '';
      fileInput.value = '';
      statusEl.textContent = 'Verbunden';
    } catch (e) {
      // Previously a failure here could vanish silently on a slow/mobile
      // connection — it must be visible, not just logged to a console
      // nobody's watching on a phone.
      statusEl.textContent = `Senden fehlgeschlagen: ${e.message}`;
      console.error('[live-chat] send failed:', e);
    } finally {
      sendButton.disabled = false;
    }
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
