// 1:1-Privat-Chat, browserseitiger Teil (Identität, Kontaktliste in
// localStorage, Rendering, Lightbox, Emoji-Picker). Die Adress-/Format-
// Logik steckt bewusst NICHT hier, sondern in chat-lib.mjs (ohne `window`
// testbar) — derselbe Schnitt wie überall sonst im Repo. Netzwerk- und
// Nachrichten-Primitive kommen unverändert aus dem Core (src/modules/chat.js
// über createChatPlugin()) — diese Datei erfindet keine neue Chat-Logik,
// nur die Oberfläche darüber.

import {
  createNetworkPlugin, createSpacesPlugin, createFileHandlerPlugin,
  createChatPlugin, createWebSocketChannel, IndexedDBFileStorageAdapter, reassembleFile,
} from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import {
  dmRoomId, inboxId, normalizeFingerprint, shortFp, fmtBytes, fmtTime, fmtDayLabel,
  linkify, mediaKind, sortContactsByActivity, buildInviteLink, parseInviteHash,
  buildChatHashRoute, parseChatHash,
} from './chat-lib.mjs';

const IDENTITY_KEY = 'qu-chat-identity';
const ALIAS_KEY = 'qu-chat-alias';
const CONTACTS_KEY = 'qu-chat-contacts';

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const statusBar = $('status-bar');
const contactListEl = $('contact-list');
const emptyStateEl = $('empty-state');
const chatPanelEl = $('chat-panel');
const backBtn = $('back-btn');
const peerAvatarEl = $('peer-avatar');
const peerNameEl = $('peer-name');
const peerStatusEl = $('peer-status');
const messageListEl = $('message-list');
const composer = $('composer');
const textInput = $('text-input');
const fileInput = $('file-input');
const attachBtn = $('attach-btn');
const pendingFilesEl = $('pending-files');
const emojiBtn = $('emoji-btn');
const emojiPicker = $('emoji-picker');
const sendBtn = $('send-btn');
const meAvatarBtn = $('me-avatar');
const meNameEl = $('me-name');
const meFpShortEl = $('me-fp-short');
const addContactBtn = $('add-contact-btn');

// --- kleine DOM-Helfer ---
function initialsOf(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}
function setAvatar(target, name, avatarDataUrl) {
  const dot = target.querySelector('.dot'); // Online-Punkt überlebt einen Avatar-Wechsel
  target.textContent = '';
  if (avatarDataUrl) {
    const img = document.createElement('img');
    img.src = avatarDataUrl;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
    target.appendChild(img);
  } else {
    target.append(initialsOf(name));
  }
  if (dot) target.appendChild(dot);
}

/** Ein hochgeladenes Bild client-seitig auf ein kleines, quadratisches JPEG verkleinern — Profilbilder bleiben so ein paar KB groß, ganz ohne die File-Chunking-Pipeline (data/files/) für etwas, das immer sofort verfügbar sein soll wie `alias`. */
async function resizeAvatar(file, size = 96) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h);
  return canvas.toDataURL('image/jpeg', 0.82);
}
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😉', '😎', '🤔', '😴', '😭',
  '😢', '😡', '🥳', '😱', '🤗', '🙄', '😇', '🤝', '👍', '👎', '👏', '🙏',
  '💪', '❤️', '💔', '💯', '🔥', '✨', '🎉', '🎂', '☕', '🍕', '🍺', '🌞',
  '🌧️', '🐶', '🐱', '🚀', '⚽', '🎮', '📸', '✅', '❌', '⏰', '📎', '👋',
];

function buildEmojiPicker() {
  for (const emoji of EMOJIS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      insertAtCursor(textInput, emoji);
      textInput.focus();
    });
    emojiPicker.appendChild(btn);
  }
}
buildEmojiPicker();

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const pos = start + text.length;
  textarea.setSelectionRange(pos, pos);
  autoGrow();
}

const TEXTAREA_MAX_HEIGHT = 104;
function autoGrow() {
  textInput.style.height = 'auto';
  const overflows = textInput.scrollHeight > TEXTAREA_MAX_HEIGHT;
  textInput.style.height = `${Math.min(textInput.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
  // Nur EINEN sichtbaren Scrollbalken zeigen, wenn wirklich mehr Text da
  // ist, als selbst die max-height noch fasst — sonst reserviert der
  // Browser (style.css's `overflow-y: hidden`-Default) schon bei einer
  // einzelnen Zeile eine Scrollbar-Spur, obwohl gar nichts überläuft.
  textInput.style.overflowY = overflows ? 'auto' : 'hidden';
}
textInput.addEventListener('input', autoGrow);

emojiBtn.addEventListener('click', () => { emojiPicker.hidden = !emojiPicker.hidden; });
document.addEventListener('click', (ev) => {
  if (!emojiPicker.hidden && !emojiPicker.contains(ev.target) && ev.target !== emojiBtn) emojiPicker.hidden = true;
});

// --- Lightbox: Vollbild + einfacher Tap-Zoom ---
const lightboxEl = $('lightbox');
const lightboxImg = $('lightbox-img');
$('lightbox-close').addEventListener('click', closeLightbox);
lightboxEl.addEventListener('click', (ev) => { if (ev.target === lightboxEl) closeLightbox(); });
lightboxImg.addEventListener('click', () => { lightboxImg.classList.toggle('zoomed'); lightboxImg.style.transform = lightboxImg.classList.contains('zoomed') ? 'scale(2.2)' : 'scale(1)'; });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !lightboxEl.hidden) closeLightbox(); });

function openLightbox(url) {
  lightboxImg.src = url;
  lightboxImg.classList.remove('zoomed');
  lightboxImg.style.transform = 'scale(1)';
  lightboxEl.hidden = false;
}
function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxImg.src = '';
}

// --- Kontaktliste (localStorage, per Fingerprint gepflegt) ---
function loadContacts() {
  try { return JSON.parse(localStorage.getItem(CONTACTS_KEY)) ?? []; } catch { return []; }
}
function saveContacts(contacts) {
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
}
let contacts = loadContacts();
function upsertContact(fp, patch) {
  const i = contacts.findIndex((c) => c.fp === fp);
  if (i === -1) contacts.push({ fp, alias: shortFp(fp), lastTs: 0, unread: 0, ...patch });
  else contacts[i] = { ...contacts[i], ...patch };
  saveContacts(contacts);
}
function contactByFp(fp) {
  return contacts.find((c) => c.fp === fp) ?? null;
}
function removeContact(fp) {
  contacts = contacts.filter((c) => c.fp !== fp);
  saveContacts(contacts);
}

async function main() {
  const qu = await loadOrCreateIdentity(IDENTITY_KEY);
  qu.use(createNetworkPlugin()).use(createSpacesPlugin()).use(createChatPlugin());
  // IndexedDB, nicht MemoryFileStorageAdapter — Anhänge (Bilder, Videos, …)
  // sollen nach dem ersten Herunterladen auch einen Reload überleben, statt
  // bei jedem Laden erneut vom Relay angefragt zu werden (renderAttachment()
  // unten prüft ohnehin schon hasComplete()/fragt nur fehlende Chunks nach —
  // mit einem rein-flüchtigen Adapter war "fehlend" nach jedem Reload aber
  // wieder alles).
  const localFileStorage = new IndexedDBFileStorageAdapter({ dbName: 'qu-chat-files' });
  qu.use(createFileHandlerPlugin({ fileStorage: localFileStorage }));

  meFpShortEl.textContent = shortFp(qu.fingerprint, 10) + '…';
  setAvatar(meAvatarBtn, localStorage.getItem(ALIAS_KEY) || qu.fingerprint);
  let myAlias = localStorage.getItem(ALIAS_KEY) || `Ich-${qu.fingerprint.slice(0, 4)}`;
  let myAvatar = null;
  meNameEl.textContent = myAlias;
  setAvatar(meAvatarBtn, myAlias);

  // Profil (alias/pub/epub) erst NACH dem Verbinden veröffentlichen, dann
  // sofort selbst syncen (`repl.sync({ topic: qu.userSpaceId })`) — sync()
  // ist reziprok (README, Abschnitt 3: "die Gegenseite fragt automatisch
  // zurück"), fragt den Relay also aktiv nach genau dem, was wir gerade
  // geschrieben haben, statt uns auf das rein zeitgesteuerte, fire-and-
  // forget `pushTopics`-Push zu verlassen. Ohne das ist ein Wettlauf
  // möglich: ein Kontakt könnte versuchen, uns eine Ende-zu-Ende-
  // verschlüsselte Nachricht zu schreiben, bevor unser `epub` beim Relay
  // angekommen ist (core/session.js's #resolveRecipientKey()).
  async function ensureAlias() {
    let alias = localStorage.getItem(ALIAS_KEY);
    if (!alias) {
      alias = prompt('Dein Anzeigename:', `Ich-${qu.fingerprint.slice(0, 4)}`) || `Ich-${qu.fingerprint.slice(0, 4)}`;
      localStorage.setItem(ALIAS_KEY, alias);
    }
    await qu.publishProfile({ alias });
    await repl.sync({ topic: qu.userSpaceId }).catch((e) => console.error('[chat] self-profile sync failed:', e));
    return alias;
  }

  // --- Verbindungsaufbau + Wiederverbindung (mobile Hintergrund-Tabs
  // trennen die WebSocket-Verbindung oft stillschweigend) — dasselbe
  // Muster wie archive/demo/live-chat.mjs, nur pro-Kontakt statt einem
  // einzelnen festen Raum: jeder DM-Raum wird nach einem Reconnect erneut
  // per ensureSynced() abonniert (siehe ensureRoom()).
  let channel;
  let repl;
  let fileTransfer;
  let reconnecting = false;
  let reconnectAttempt = 0;
  const ensuredRoomIds = new Map(); // fp -> roomId, schon abonniert/erstellt

  async function connectToRelay() {
    channel = createWebSocketChannel(relayUrl());
    await channel.connect();
    // '' als Präfix (matcht jede Id) — Räume entstehen dynamisch per
    // Kontakt (dmRoomId()), ihre Id steht beim Verbinden nicht fest;
    // Gegenstück zum Relay's eigenem allowDynamicSubscribe (README,
    // "Ein App-unabhängiger Relay") — was WIR selbst schreiben, pushen wir
    // immer, unabhängig vom Topic.
    repl = await qu.connect(channel, { pushTopics: [''] });
    fileTransfer = qu.fileTransfer(channel, localFileStorage);
    channel.onClose(() => scheduleReconnect());
    statusBar.textContent = 'Verbunden';
    statusBar.classList.remove('err');
    reconnectAttempt = 0;
    // Nach jedem (Wieder-)Verbinden alle bereits bekannten Räume UND den
    // eigenen Briefkasten (chat-lib.mjs's inboxId()) erneut abonnieren —
    // eine neue repl-Instanz kennt keine vorherigen Topics.
    repl.ensureSynced(`${inboxId(qu.fingerprint)}/requests`).catch((e) => console.error('[chat] inbox re-watch failed:', e));
    for (const [fp, roomId] of ensuredRoomIds) {
      repl.ensureSynced(roomId).catch((e) => console.error('[chat] re-watch failed:', fp, e));
      repl.ensureSynced(`~${fp}/avatar`).catch((e) => console.error('[chat] avatar re-watch failed:', fp, e));
    }
  }

  function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempt++;
    const delayMs = Math.min(1000 * 2 ** (reconnectAttempt - 1), 15000);
    statusBar.textContent = `Verbindung getrennt — neuer Versuch in ${Math.round(delayMs / 1000)}s …`;
    statusBar.classList.add('err');
    setTimeout(async () => {
      try { await connectToRelay(); } catch (e) {
        console.error('[chat] reconnect failed:', e);
        statusBar.textContent = `Wiederverbindung fehlgeschlagen: ${e.message}`;
      } finally { reconnecting = false; }
    }, delayMs);
  }

  await connectToRelay();
  myAlias = await ensureAlias();
  meNameEl.textContent = myAlias;
  setAvatar(meAvatarBtn, myAlias);
  myAvatar = (await qu.get(`~${qu.fingerprint}/avatar`))?.value ?? null;
  if (myAvatar) setAvatar(meAvatarBtn, myAlias, myAvatar);

  // Eigenen Briefkasten abonnieren (siehe ensureRoom()s Ping unten) — ein
  // von einem Kontakt remote gestarteter Chat taucht dadurch von selbst
  // auf, ganz ohne dass wir ihn zuerst hinzugefügt haben müssten. Erst
  // NACH connectToRelay() registrieren: `.map()`s Netzwerk-Subscribe
  // (README, "ensureSynced() ... automatisch, sobald ein node.on/map
  // aktiviert wird") braucht eine bereits aktive Verbindung, sonst läuft
  // es beim allerersten Aufruf ins Leere.
  qu.get(inboxId(qu.fingerprint)).get('requests').map((q) => handleInboxRequest(q));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !reconnecting && !channel.isOpen()) scheduleReconnect();
  });
  window.addEventListener('online', () => { if (!reconnecting && !channel.isOpen()) scheduleReconnect(); });

  // --- Pro-Kontakt-Zustand ---
  const messagesByRoom = new Map(); // fp -> QuBit[]
  const seenIdsByRoom = new Map(); // fp -> Set<id>  (Reconnect-Redelivery-sicher)
  const receiptsByRoom = new Map(); // fp -> { [fingerprint]: upToTs }
  const stopHeartbeatByRoom = new Map(); // fp -> stop()
  const unsubsByRoom = new Map(); // fp -> Array<() => void>, siehe ensureRoom()/deleteContact()
  const aliasCache = new Map([[qu.fingerprint, myAlias]]);
  const avatarCache = new Map(); // fp -> dataUrl | null (null = bekannt abwesend, nicht "noch nicht geprüft")
  let activeFp = null;

  async function aliasFor(fp) {
    if (fp === qu.fingerprint) return myAlias;
    const contact = contactByFp(fp);
    if (contact?.alias) return contact.alias;
    if (aliasCache.has(fp)) return aliasCache.get(fp);
    try {
      const profile = await qu.getProfile(fp);
      const name = profile.alias ?? shortFp(fp);
      aliasCache.set(fp, name);
      return name;
    } catch { return shortFp(fp); }
  }

  /**
   * `~<fp>/avatar` — kein reservierter Profil-Pfad wie pub/epub/alias, aber
   * genauso ein einzelner LWW-Wert (data-URL), kein Datei-Upload über die
   * Chunking-Pipeline: ein Profilbild soll sofort da sein, sobald der Rest
   * des Profils synct ist (siehe ensureRoom()'s `~${fp}`-Sync). Ein
   * negatives Ergebnis wird bewusst NICHT im Cache gehalten — anders als
   * `aliasFor()`s Fallback (der Fingerprint bleibt ohnehin immer als
   * Anzeigename da) wäre "noch nicht synct" sonst nicht von "hat wirklich
   * keins" zu unterscheiden, und ein zu früher Aufruf (bevor ensureRoom()
   * den Kontakt-Userspace überhaupt gesynct hat) würde den fehlenden Wert
   * dauerhaft einfrieren.
   */
  async function avatarFor(fp) {
    if (fp === qu.fingerprint) return myAvatar;
    const contact = contactByFp(fp);
    if (contact?.avatar) return contact.avatar;
    if (avatarCache.has(fp)) return avatarCache.get(fp);
    try {
      const q = await qu.get(`~${fp}/avatar`);
      const url = q?.value ?? null;
      if (url) {
        avatarCache.set(fp, url);
        if (contact) upsertContact(fp, { avatar: url });
      }
      return url;
    } catch { return null; }
  }

  async function ensureRoom(fp) {
    if (ensuredRoomIds.has(fp)) return ensuredRoomIds.get(fp);
    const roomId = dmRoomId(qu.fingerprint, fp);
    ensuredRoomIds.set(fp, roomId);
    messagesByRoom.set(fp, []);
    seenIdsByRoom.set(fp, new Set());

    const unsubs = [];
    unsubsByRoom.set(fp, unsubs);
    unsubs.push(qu.onMessage(roomId, (q) => handleIncomingMessage(fp, roomId, q)));
    unsubs.push(qu.onPresenceChange(roomId, async () => renderPresence(fp, roomId)));
    unsubs.push(qu.onReadReceipt(roomId, async () => {
      receiptsByRoom.set(fp, await qu.getReadReceipts(roomId));
      if (activeFp === fp) renderTicks(fp);
    }));

    // Den Kontakt-Userspace (pub/epub/alias, immer öffentlich lesbar —
    // core/space.js's RESERVED_PROFILE_PATHS) VOR dem Raum selbst syncen:
    // sendMessage() unten verschlüsselt explizit für beide Mitglieder
    // (encryptFor) und braucht dafür den ECDH-Public-Key jedes Empfängers
    // bereits lokal bekannt (core/session.js's #resolveRecipientKey()) —
    // sonst schlägt das allererste Senden fehl, falls das lokale Store
    // frisch ist (z. B. nach einem Reload).
    await repl.sync({ topic: `~${fp}` }).catch((e) => console.error('[chat] peer profile sync failed:', fp, e));
    await repl.ensureSynced(roomId);

    // Live-Abo auf den Avatar (nicht nur der einmalige Sync oben) — ändert
    // ein Kontakt sein Profilbild, während der Chat schon offen ist, muss
    // das sofort ankommen, genau wie Alias/Presence bereits live sind.
    // `.on()` liefert per Default nur ZUKÜNFTIGE Änderungen (kein initial:
    // true wie map(), core/space-handle.js's on()-Doku) — die aktuelle
    // Anzeige oben (peer-avatar/Kontaktliste) speist sich weiterhin aus
    // avatarFor()s einmaligem Abruf, dieses Abo hält sie danach aktuell.
    unsubs.push(qu.get(`~${fp}`).get('avatar').on((q) => {
      const url = q?.value ?? null;
      avatarCache.set(fp, url);
      upsertContact(fp, { avatar: url });
      if (activeFp === fp) setAvatar(peerAvatarEl, contactByFp(fp)?.alias ?? fp, url);
      renderContactList();
    }));

    const manifest = await qu.get(roomId);
    if (!manifest) {
      const members = [qu.fingerprint, fp].sort();
      // `readers: ['*']` ist bewusst OFFEN, nicht auf die zwei Mitglieder
      // beschränkt: ein Relay darf ein QuBit nur dann überhaupt
      // weiterleiten, wenn es selbst in dessen `readers` steht
      // (core/acl.js's filterForReader() — ein Relay ist sonst einfach ein
      // weiterer, nicht gelisteter Leser). Restriktive `readers` würde die
      // eigentliche Übertragung über einen echten Relay strukturell
      // blockieren, nicht nur "verstecken". Die eigentliche Privatsphäre
      // kommt stattdessen aus Verschlüsselung (sendMessage()s
      // `encryptFor` unten) — derselbe Aufbau wie Signal: der Server sieht
      // Chiffretext, keinen Klartext. `writers` bleibt eng (nur die zwei
      // Mitglieder dürfen in diesen Raum schreiben).
      const space = qu.createSpaceAt(roomId, { writers: members, readers: ['*'], admins: members });
      await space.ready.catch((e) => console.error('[chat] room bootstrap failed:', roomId, e));
    }

    receiptsByRoom.set(fp, await qu.getReadReceipts(roomId));
    renderPresence(fp, roomId);
    stopHeartbeatByRoom.set(fp, qu.startHeartbeat(roomId, { intervalMs: 8000 }));

    // In den Briefkasten (chat-lib.mjs's inboxId()) des Kontakts schreiben,
    // damit ein von UNS gestarteter Chat spätestens jetzt (nicht erst mit
    // der ersten Nachricht) beim Kontakt auftaucht, ohne dass der uns
    // zuerst selbst hätte hinzufügen müssen — der Briefkasten-Space bleibt
    // bewusst manifestlos (siehe inboxId()s Doku: "kein Manifest = jeder
    // darf schreiben"). `.get(qu.fingerprint)` als fester Schlüssel: ein
    // erneuter Ping (z. B. beim nächsten App-Start) überschreibt den alten
    // statt eine wachsende Liste zu bilden.
    qu.get(inboxId(fp)).get('requests').get(qu.fingerprint).put({ fromFp: qu.fingerprint, alias: myAlias, roomId })
      .catch((e) => console.error('[chat] inbox ping failed:', fp, e));

    return roomId;
  }

  /** Reagiert auf einen eingehenden Briefkasten-Eintrag (siehe oben) — legt den Absender bei Bedarf als Kontakt an und stellt sicher, dass der Raum lokal existiert, ganz ohne dass die Nutzerin ihn vorher selbst hinzugefügt haben muss. */
  function handleInboxRequest(q) {
    const fromFp = q?.value?.fromFp;
    if (!fromFp || fromFp === qu.fingerprint) return;
    if (!contactByFp(fromFp)) {
      upsertContact(fromFp, { alias: q.value.alias || shortFp(fromFp), lastTs: 0, unread: 0 });
      renderContactList();
    }
    ensureRoom(fromFp).catch((e) => console.error('[chat] ensureRoom (inbox) failed:', fromFp, e));
  }

  function handleIncomingMessage(fp, roomId, q) {
    const seen = seenIdsByRoom.get(fp);
    if (seen.has(q.id)) return;
    seen.add(q.id);
    const list = messagesByRoom.get(fp);
    list.push(q);
    list.sort((a, b) => a.ts - b.ts);

    const mine = q.writer === qu.fingerprint;
    const preview = q.value?.text || (q.refs?.length ? '📎 Anhang' : '');
    const contact = contactByFp(fp);
    const unread = mine || activeFp === fp ? 0 : (contact?.unread ?? 0) + 1;
    upsertContact(fp, { lastTs: q.ts, lastPreview: preview, lastMine: mine, unread });
    renderContactList();

    if (activeFp === fp) {
      appendLiveMessage(q);
      if (document.hasFocus()) markActiveRead();
    }

    // Lokale Benachrichtigung für "Tab läuft noch, ist aber nicht im
    // Fokus" (Handy gesperrt, anderer Tab aktiv, …) — der komplementäre
    // Fall zu echtem Web Push (sw.js/relay.mjs's push-Hook), das der
    // Relay bewusst NUR für getrennte Verbindungen auslöst (siehe dort);
    // beide Wege feuern also nie für dasselbe Ereignis gleichzeitig.
    if (!mine && !document.hasFocus() && Notification.permission === 'granted') {
      try {
        const notif = new Notification('QU Chat', { body: `${contactByFp(fp)?.alias ?? shortFp(fp)} hat dir geschrieben`, tag: fp });
        notif.addEventListener('click', () => { window.focus(); openContact(fp); notif.close(); });
      } catch { /* z. B. Safari verweigert new Notification() aus einem Service-Worker-losen Kontext manchmal leise — kein harter Fehler */ }
    }
  }

  async function markActiveRead() {
    if (!activeFp) return;
    const roomId = ensuredRoomIds.get(activeFp);
    const list = messagesByRoom.get(activeFp) ?? [];
    const last = list.at(-1);
    if (!last) return;
    await qu.markRead(roomId, last.ts);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markActiveRead(); });
  window.addEventListener('focus', () => markActiveRead());

  function renderPresence(fp, roomId) {
    qu.getPresence(roomId).then((presence) => {
      const info = presence[fp];
      const online = !!info?.online;
      if (activeFp === fp) {
        peerStatusEl.textContent = online ? 'online' : (info?.lastSeen ? `zuletzt online ${fmtTime(info.lastSeen)}` : 'offline');
        peerStatusEl.classList.toggle('online', online);
        const dot = peerAvatarEl.querySelector('.dot') ?? peerAvatarEl.appendChild(el('span', 'dot'));
        dot.classList.toggle('online', online);
      }
      const listItem = contactListEl.querySelector(`[data-fp="${fp}"] .dot`);
      if (listItem) listItem.classList.toggle('online', online);
    }).catch(() => {});
  }

  function renderTicks(fp) {
    const receipts = receiptsByRoom.get(fp) ?? {};
    for (const li of messageListEl.querySelectorAll('[data-mine="1"]')) {
      const ts = Number(li.dataset.ts);
      const read = Object.entries(receipts).some(([reader, upTo]) => reader !== qu.fingerprint && upTo >= ts);
      const tick = li.querySelector('.tick');
      if (tick) { tick.textContent = read ? '✓✓' : '✓'; tick.classList.toggle('read', read); }
    }
  }

  // --- Rendering: Kontaktliste ---
  function renderContactList() {
    contactListEl.textContent = '';
    const sorted = sortContactsByActivity(contacts);
    if (!sorted.length) {
      const empty = el('li', 'empty-list');
      empty.append('Noch keine Kontakte. ');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Jetzt hinzufügen';
      btn.addEventListener('click', () => openAddContactModal());
      empty.appendChild(btn);
      contactListEl.appendChild(empty);
      return;
    }
    for (const c of sorted) {
      const li = el('li', `contact${activeFp === c.fp ? ' active' : ''}`);
      li.dataset.fp = c.fp;
      const avatar = el('div', 'avatar sm');
      setAvatar(avatar, c.alias, c.avatar);
      avatar.appendChild(el('span', 'dot'));
      li.appendChild(avatar);
      if (!c.avatar) avatarFor(c.fp).then((url) => { if (url) setAvatar(avatar, c.alias, url); });

      const body = el('div', 'contact-body');
      const top = el('div', 'contact-top');
      top.appendChild(el('div', 'contact-name', c.alias));
      top.appendChild(el('div', 'contact-time', c.lastTs ? fmtTime(c.lastTs) : ''));
      body.appendChild(top);
      const previewRow = el('div', 'contact-preview');
      const previewText = c.lastTs ? `${c.lastMine ? 'Du: ' : ''}${c.lastPreview ?? ''}` : 'Noch keine Nachrichten';
      previewRow.appendChild(el('div', 'contact-last', previewText));
      if (c.unread) previewRow.appendChild(el('div', 'contact-unread', String(c.unread)));
      body.appendChild(previewRow);
      li.appendChild(body);

      li.addEventListener('click', () => openContact(c.fp));
      contactListEl.appendChild(li);
    }
  }

  // --- Rendering: Chat-Panel ---

  /** War die Liste (kurz bevor neuer Inhalt reinkommt) bereits am Ende? "Nahe dran" statt exakt — ein paar Pixel Toleranz für Rundungsfehler/Sub-Pixel-Scrollpositionen. */
  function isNearBottom() {
    return messageListEl.scrollHeight - messageListEl.scrollTop - messageListEl.clientHeight <= 60;
  }

  /**
   * Nur dann ans Ende scrollen, wenn man SCHON dort war — sonst reißt
   * jede neue Nachricht (oder ein nachträglich ladendes Bild/Video, das
   * die Liste erst jetzt sichtbar wachsen lässt) jemanden aus der
   * gerade gelesenen älteren Historie. Wird an zwei Stellen aufgerufen:
   * beim Anhängen einer neuen Live-Nachricht (appendLiveMessage()) und
   * innerhalb von renderAttachment(), sobald ein Anhang tatsächlich
   * seine endgültige Höhe erreicht (Bild `load`, Video `loadedmetadata`,
   * oder direkt nach dem Einfügen für Audio/Datei-Fallback).
   */
  function stickToBottomIfNeeded() {
    if (isNearBottom()) messageListEl.scrollTop = messageListEl.scrollHeight;
  }

  async function renderAttachment(refId) {
    const manifestQ = await qu.get(refId);
    if (!manifestQ) return el('div', 'attachment-progress', 'Anhang nicht gefunden');
    const manifest = manifestQ.value;
    const kind = mediaKind(manifest.mime);
    const wrap = el('div', 'attachment');
    let status = el('div', 'attachment-progress', 'wird geladen …');
    wrap.appendChild(status);

    /** Zeigt einen Fehler + "Erneut versuchen"-Button statt eines kaputten Bild-/Player-Elements — z. B. wenn ein Chunk beim Absender/Relay (noch) nicht verfügbar ist. */
    function showError(message) {
      wrap.textContent = '';
      wrap.appendChild(el('div', 'attachment-progress', message));
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'attachment-btn';
      retry.textContent = 'Erneut versuchen';
      retry.addEventListener('click', () => {
        status = el('div', 'attachment-progress', 'wird geladen …');
        wrap.textContent = '';
        wrap.appendChild(status);
        reveal();
      });
      wrap.appendChild(retry);
    }

    async function reveal() {
      try {
        let complete = await fileTransfer.hasComplete(refId);
        if (!complete) {
          // waitUntilReady() fragt nur, ob der RELAY selbst inzwischen
          // alle Chunks hat (vom Absender gespiegelt, siehe relay/relay.mjs's
          // proaktives Mirroring) — überträgt dabei noch KEIN einziges Byte
          // zu UNS. requestFile() ist der tatsächliche Download-Schritt und
          // muss deshalb IMMER laufen, sobald überhaupt etwas fehlt — nicht
          // nur, wenn waitUntilReady() "noch nicht bereit" meldet (das war
          // der Bug: bei "bereit" wurde requestFile() übersprungen, wodurch
          // reassembleFile() unten `null` lieferte und daraus ein kaputter
          // Blob("null") statt eines Bildes/Videos entstand).
          await fileTransfer.waitUntilReady(refId, {
            onProgress: () => { status.textContent = 'wird vom Absender übertragen …'; },
          });
          await fileTransfer.requestFile(refId, {
            onProgress: ({ attempt, maxAttempts }) => { status.textContent = `Lädt … (${attempt}/${maxAttempts})`; },
          });
          complete = await fileTransfer.hasComplete(refId);
        }
        if (!complete) { showError('Anhang ist (noch) nicht vollständig verfügbar.'); return; }

        const bytes = await reassembleFile(localFileStorage, manifest);
        if (!bytes) { showError('Anhang konnte nicht zusammengesetzt werden.'); return; }
        const blob = new Blob([bytes], { type: manifest.mime });
        const url = URL.createObjectURL(blob);
        status.remove();

        // Name+MIME-Typ stehen immer im Manifest (data/files/manifest.js's
        // publishFile() speichert beides beim Senden, siehe app.mjs's
        // composer-Handler) — ein Downloadlink ist also IMMER möglich,
        // auch wenn der Browser den konkreten Codec (z. B. HEVC/H.265 in
        // vielen .mov-Dateien von Smartphone-Kameras) nicht abspielen kann.
        function downloadFallback(note) {
          wrap.textContent = '';
          if (note) wrap.appendChild(el('div', 'attachment-progress', note));
          const a = document.createElement('a');
          a.className = 'attachment-file';
          a.href = url;
          a.download = manifest.name;
          a.appendChild(el('span', 'file-ic', kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📄'));
          const meta = el('div');
          meta.appendChild(el('div', '', manifest.name));
          meta.appendChild(el('div', 'file-meta', `${manifest.mime} · ${fmtBytes(manifest.size ?? bytes.length)}`));
          a.appendChild(meta);
          wrap.appendChild(a);
          stickToBottomIfNeeded();
        }

        if (kind === 'image') {
          const img = el('img', 'attachment-media');
          img.src = url;
          img.alt = manifest.name;
          img.addEventListener('click', () => openLightbox(url));
          // `mime` mit "image/" reicht nicht, um Anzeigbarkeit zu
          // garantieren — vor allem Foto-Uploads von Smartphones sind oft
          // HEIC/HEIF, was so gut wie kein Browser in <img> dekodieren
          // kann. Ein fehlgeschlagenes <img> zeigt sonst nur seinen
          // alt-Text (hier: der Dateiname) an, ganz ohne sichtbaren
          // Fehler — genau das sah wie "nur der Name, kein Bild" aus.
          img.addEventListener('error', () => downloadFallback('Dieses Bildformat kann im Browser nicht angezeigt werden (z. B. HEIC/HEIF von einem Smartphone).'));
          // Die eigentliche Höhe steht erst nach `load` fest (vorher hat
          // ein <img> ohne width/height keine intrinsische Größe) — genau
          // der Moment, der die Liste sichtbar wachsen lässt, siehe
          // stickToBottomIfNeeded()s Doku unten.
          img.addEventListener('load', stickToBottomIfNeeded);
          wrap.appendChild(img);
        } else if (kind === 'video') {
          const video = document.createElement('video');
          video.className = 'attachment-media';
          video.src = url;
          video.controls = true;
          video.playsInline = true;
          // Manche Kamera-Videos (z. B. .mov mit HEVC) haben einen für den
          // Browser unbekannten Codec, obwohl mime mit "video/" beginnt —
          // dann liefert <video> nur einen error-Event, kein Bild. Statt
          // eines stillen/leeren Players: sofort auf den Download
          // umschalten, die Datei bleibt so nutzbar.
          video.addEventListener('error', () => downloadFallback('Dieses Videoformat kann im Browser nicht abgespielt werden.'));
          video.addEventListener('loadedmetadata', stickToBottomIfNeeded);
          wrap.appendChild(video);
        } else if (kind === 'audio') {
          const audio = document.createElement('audio');
          audio.src = url;
          audio.controls = true;
          audio.addEventListener('error', () => downloadFallback('Dieses Audioformat kann im Browser nicht abgespielt werden.'));
          wrap.appendChild(audio);
        } else {
          downloadFallback();
        }
        stickToBottomIfNeeded();
      } catch (e) {
        showError(`Fehler beim Laden (${e.message})`);
        console.error('[chat] attachment failed:', e);
      }
    }
    reveal();
    return wrap;
  }

  function renderMessageText(container, text) {
    for (const seg of linkify(text)) {
      if (seg.type === 'text') {
        container.appendChild(document.createTextNode(seg.value));
      } else {
        const a = document.createElement('a');
        a.href = seg.value;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = seg.value;
        container.appendChild(a);
      }
    }
  }

  function buildLinkPreview(text) {
    const link = linkify(text).find((s) => s.type === 'link');
    if (!link) return null;
    const a = document.createElement('a');
    a.className = 'msg-link';
    a.href = link.value;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const host = el('div', 'link-host', `🔗 ${link.hostname}`);
    a.appendChild(host);
    a.appendChild(el('div', 'link-url', link.value));
    return a;
  }

  /** Baut genau ein `<li class="msg">` — geteilt zwischen dem vollständigen Neuaufbau (renderMessageList()) und dem Anhängen einer einzelnen neuen Live-Nachricht (appendLiveMessage()), damit beide garantiert dasselbe Markup erzeugen. */
  async function buildMessageItem(q) {
    const mine = q.writer === qu.fingerprint;
    const li = el('li', `msg${mine ? ' mine' : ''}`);
    li.dataset.ts = q.ts;
    li.dataset.mine = mine ? '1' : '0';
    const bubble = el('div', 'msg-bubble');
    if (q.value?.text) {
      const textEl = el('div', 'msg-text');
      renderMessageText(textEl, q.value.text);
      bubble.appendChild(textEl);
      const preview = buildLinkPreview(q.value.text);
      if (preview) bubble.appendChild(preview);
    }
    for (const refId of q.refs ?? []) {
      bubble.appendChild(await renderAttachment(refId));
    }
    li.appendChild(bubble);
    const meta = el('div', 'msg-meta');
    meta.appendChild(document.createTextNode(fmtTime(q.ts)));
    if (mine) meta.appendChild(el('span', 'tick', '✓'));
    li.appendChild(meta);
    return li;
  }

  let lastRenderedDay = null; // von renderMessageList() (Neuaufbau) UND appendLiveMessage() (einzelne neue Nachricht) gemeinsam gepflegter Tages-Trenner-Zustand der aktuell angezeigten Liste

  async function renderMessageList(fp) {
    messageListEl.textContent = '';
    lastRenderedDay = null;
    const list = messagesByRoom.get(fp) ?? [];
    for (const q of list) {
      const dayLabel = fmtDayLabel(q.ts);
      if (dayLabel !== lastRenderedDay) { messageListEl.appendChild(el('li', 'day-sep', dayLabel)); lastRenderedDay = dayLabel; }
      messageListEl.appendChild(await buildMessageItem(q));
    }
    // Ein frisch geöffneter Chat startet immer unten (neueste Nachricht),
    // unabhängig vom bisherigen Scroll-Zustand — anders als
    // appendLiveMessage() unten, das das bewusst NUR tut, wenn man schon
    // dort war.
    messageListEl.scrollTop = messageListEl.scrollHeight;
    renderTicks(fp);
  }

  /** Hängt EINE neu eingetroffene Live-Nachricht an, statt die komplette Liste neu aufzubauen (kein erneutes Laden/Rendern schon vorhandener Anhänge bei jeder neuen Nachricht) — folgt dem Ende nur, wenn man vorher schon dort war (isNearBottom()), reißt also niemanden aus der gerade gelesenen älteren Historie. */
  async function appendLiveMessage(q) {
    const stick = isNearBottom();
    const dayLabel = fmtDayLabel(q.ts);
    if (dayLabel !== lastRenderedDay) { messageListEl.appendChild(el('li', 'day-sep', dayLabel)); lastRenderedDay = dayLabel; }
    messageListEl.appendChild(await buildMessageItem(q));
    if (stick) messageListEl.scrollTop = messageListEl.scrollHeight;
    renderTicks(activeFp);
  }

  async function openContact(fp) {
    activeFp = fp;
    const contact = contactByFp(fp);
    peerNameEl.textContent = contact?.alias ?? shortFp(fp);
    setAvatar(peerAvatarEl, contact?.alias ?? fp, contact?.avatar);
    peerStatusEl.textContent = '…';
    appEl.classList.add('chat-open');
    emptyStateEl.classList.remove('show');
    chatPanelEl.classList.remove('hidden-empty');
    // Direktlink für diesen Chat in die URL — Navigation dorthin (Teilen,
    // Lesezeichen, Vor-/Zurück-Button) siehe buildChatHashRoute()/
    // parseChatHash() (chat-lib.mjs) und den hashchange-Listener unten.
    const targetHash = buildChatHashRoute(fp);
    if (location.hash !== targetHash) location.hash = targetHash;

    // Erst NACH ensureRoom() (das den Kontakt-Userspace synct, siehe dort)
    // nach dem Avatar fragen — vorher lokal nachzusehen würde bei einem
    // gerade erst hinzugefügten Kontakt fast immer "keiner" liefern, weil
    // schlicht noch nichts synct war.
    const roomId = await ensureRoom(fp);
    if (!contact?.avatar) avatarFor(fp).then((url) => {
      if (!url) return;
      if (activeFp === fp) setAvatar(peerAvatarEl, contactByFp(fp)?.alias ?? fp, url);
      renderContactList();
    });
    renderPresence(fp, roomId);
    upsertContact(fp, { unread: 0 });
    renderContactList();
    await renderMessageList(fp);
    await markActiveRead();
  }

  function closeContact() {
    activeFp = null;
    appEl.classList.remove('chat-open');
    emptyStateEl.classList.add('show');
    chatPanelEl.classList.add('hidden-empty');
    if (location.hash) location.hash = '';
  }
  backBtn.addEventListener('click', closeContact);

  /**
   * Löscht einen Chat nur LOKAL — der Nachrichtenverlauf bleibt für den
   * Kontakt selbst unangetastet (QU ist ein append-only Log, Whitepaper
   * §7; "löschen" heißt hier "wir hören auf hinzuschauen", nicht "die
   * Vergangenheit verschwindet für alle Beteiligten", genau wie bei
   * jedem anderen 1:1-Chat auch). Räumt alles auf, was ensureRoom() für
   * diesen Kontakt angelegt hat: laufende Live-Abos (unsubsByRoom),
   * Presence-Heartbeat, und den gesamten Pro-Kontakt-Zustand — ein
   * erneutes Öffnen (z. B. über einen Direktlink oder eine neue
   * Nachricht vom Kontakt) ruft ensureRoom() einfach wieder frisch auf.
   */
  function deleteContact(fp) {
    stopHeartbeatByRoom.get(fp)?.();
    stopHeartbeatByRoom.delete(fp);
    for (const off of unsubsByRoom.get(fp) ?? []) off();
    unsubsByRoom.delete(fp);
    messagesByRoom.delete(fp);
    seenIdsByRoom.delete(fp);
    receiptsByRoom.delete(fp);
    ensuredRoomIds.delete(fp);
    avatarCache.delete(fp);
    aliasCache.delete(fp);
    removeContact(fp);
    if (activeFp === fp) closeContact();
    renderContactList();
  }
  $('delete-chat-btn').addEventListener('click', () => {
    if (!activeFp) return;
    const alias = contactByFp(activeFp)?.alias ?? shortFp(activeFp);
    if (!confirm(`Chat mit ${alias} löschen?\n\nDer Nachrichtenverlauf bleibt beim Kontakt erhalten, wird hier aber entfernt.`)) return;
    deleteContact(activeFp);
  });

  /** Ein Chat wird über seinen Direktlink (`#<fingerprint>`, siehe buildChatHashRoute()) geöffnet — im Gegensatz zum Einladungslink (`#add=...`) ohne Zwischenschritt: die Kontaktliste wird bei Bedarf (Alias per qu.getProfile()) automatisch ergänzt, genau wie handleInboxRequest() es für einen remote gestarteten Chat schon tut. */
  async function openContactByHash(fp) {
    if (fp === qu.fingerprint) return;
    if (!contactByFp(fp)) {
      let alias = shortFp(fp);
      try { alias = (await qu.getProfile(fp)).alias ?? alias; } catch { /* Profil (noch) nicht synct — Fallback bleibt der Fingerprint, aliasFor()/ensureRoom() holen es später live nach */ }
      upsertContact(fp, { alias, lastTs: 0, unread: 0 });
      renderContactList();
    }
    openContact(fp);
  }

  // Direktlinks/Vor-Zurück: `#<fingerprint>` öffnet den Chat, ein leerer
  // Hash (z. B. über den Zurück-Button oder Browser-"Zurück") schließt ihn.
  window.addEventListener('hashchange', () => {
    const chatFp = parseChatHash(location.hash);
    if (chatFp) { if (activeFp !== chatFp) openContactByHash(chatFp); return; }
    if (!location.hash && activeFp) closeContact();
  });

  // --- Senden ---
  let pendingFiles = [];
  function renderPendingFiles() {
    pendingFilesEl.textContent = '';
    pendingFiles.forEach((file, i) => {
      const chip = el('div', 'pending-file');
      chip.appendChild(document.createTextNode(`${mediaKind(file.type) === 'image' ? '🖼️' : mediaKind(file.type) === 'video' ? '🎬' : mediaKind(file.type) === 'audio' ? '🎵' : '📎'} ${file.name}`));
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.textContent = '×';
      rm.addEventListener('click', () => { pendingFiles.splice(i, 1); renderPendingFiles(); });
      chip.appendChild(rm);
      pendingFilesEl.appendChild(chip);
    });
  }
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    pendingFiles.push(...fileInput.files);
    fileInput.value = '';
    renderPendingFiles();
  });

  composer.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!activeFp) return;
    const text = textInput.value.trim();
    const files = pendingFiles;
    if (!text && !files.length) return;
    sendBtn.disabled = true;
    try {
      const roomId = ensuredRoomIds.get(activeFp);
      const attachments = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        attachments.push({ bytes, name: file.name, mime: file.type || 'application/octet-stream', fileStorage: localFileStorage });
      }
      // readers ist bewusst ['*'] (siehe ensureRoom()) — Vertraulichkeit
      // kommt hier ausschließlich aus dem expliziten encryptFor, nicht aus
      // einer restriktiven Space-ACL (die Default-Auto-Verschlüsselung in
      // core/session.js griffe nur bei eingeschränkten `readers`).
      await qu.sendMessage(roomId, { text, attachments, encryptFor: [qu.fingerprint, activeFp] });
      textInput.value = '';
      autoGrow();
      pendingFiles = [];
      renderPendingFiles();
    } catch (e) {
      console.error('[chat] send failed:', e);
      statusBar.textContent = `Senden fehlgeschlagen: ${e.message}`;
      statusBar.classList.add('err');
      setTimeout(() => { statusBar.textContent = 'Verbunden'; statusBar.classList.remove('err'); }, 4000);
    } finally {
      sendBtn.disabled = false;
    }
  });
  textInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); composer.requestSubmit(); }
  });

  // --- Profil-Modal ---
  const profileModal = $('profile-modal');
  const avatarPreviewBtn = $('avatar-preview-btn');
  const avatarInput = $('avatar-input');
  let pendingAvatar; // undefined = unverändert, null = "entfernen", dataUrl = neu gewählt
  meAvatarBtn.addEventListener('click', () => {
    $('alias-input').value = myAlias;
    $('my-fp-full').textContent = qu.fingerprint;
    pendingAvatar = undefined;
    setAvatar(avatarPreviewBtn, myAlias, myAvatar);
    profileModal.hidden = false;
    refreshPushUI();
  });
  $('profile-cancel-btn').addEventListener('click', () => { profileModal.hidden = true; });
  profileModal.addEventListener('click', (ev) => { if (ev.target === profileModal) profileModal.hidden = true; });
  $('avatar-pick-btn').addEventListener('click', () => avatarInput.click());
  $('avatar-clear-btn').addEventListener('click', () => {
    pendingAvatar = null;
    setAvatar(avatarPreviewBtn, $('alias-input').value || myAlias);
  });
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    avatarInput.value = '';
    if (!file) return;
    try {
      pendingAvatar = await resizeAvatar(file);
      setAvatar(avatarPreviewBtn, $('alias-input').value || myAlias, pendingAvatar);
    } catch (e) { console.error('[chat] avatar resize failed:', e); }
  });
  $('profile-save-btn').addEventListener('click', async () => {
    const alias = $('alias-input').value.trim() || myAlias;
    myAlias = alias;
    localStorage.setItem(ALIAS_KEY, alias);
    meNameEl.textContent = alias;
    aliasCache.set(qu.fingerprint, alias);
    await qu.publishProfile({ alias });
    if (pendingAvatar !== undefined) {
      myAvatar = pendingAvatar;
      await qu.own.get('avatar').put(myAvatar); // `null` löscht (LWW-Register, wie jeder andere put())
    }
    setAvatar(meAvatarBtn, alias, myAvatar);
    await repl.sync({ topic: qu.userSpaceId }).catch((e) => console.error('[chat] self-profile sync failed:', e));
    profileModal.hidden = true;
  });
  $('copy-fp-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(qu.fingerprint).catch(() => {});
  });
  $('share-link-btn').addEventListener('click', async () => {
    const link = buildInviteLink(location.origin + location.pathname, qu.fingerprint);
    if (navigator.share) { await navigator.share({ title: 'QU Chat', text: `Schreib mir im Chat: ${link}` }).catch(() => {}); }
    else { await navigator.clipboard.writeText(link).catch(() => {}); }
  });

  // --- Push-Benachrichtigungen (Web Push — relay/webpush.mjs + sw.js) ---
  // Ganz bewusst NICHT ungefragt beim Laden angeboten (Notification.
  // requestPermission() aus dem Nichts ist die Art Prompt, die die
  // meisten Nutzer:innen sofort wegklicken) — nur über den expliziten
  // Button im Profil, ein echter Nutzer-Klick. `pushToggleBtn`s Label und
  // `pushStatusEl`s Text spiegeln IMMER den echten Zustand (nicht
  // unterstützt/blockiert/aus/aktiv), nie nur "an, weil wir's mal
  // versucht haben".
  const pushToggleBtn = $('push-toggle-btn');
  const pushStatusEl = $('push-status');
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  let vapidPublicKey; // undefined = noch nicht abgefragt, null = Server hat kein Push konfiguriert
  let swRegistration = null;

  function urlBase64ToUint8Array(base64url) {
    const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  /** `overrideStatus`, wenn gesetzt, ersetzt nur den Statustext (z. B. eine Fehlermeldung aus dem Klick-Handler unten) — sonst würde dieser Aufruf im `finally` des Klick-Handlers eine gerade erst gezeigte Fehlermeldung sofort wieder mit dem generischen "Aus."/"Aktiv" überschreiben. */
  async function refreshPushUI(overrideStatus) {
    if (!pushSupported) {
      pushToggleBtn.disabled = true;
      pushToggleBtn.textContent = 'Nicht unterstützt';
      pushStatusEl.textContent = overrideStatus ?? 'Dieser Browser unterstützt keine Web-Push-Benachrichtigungen.';
      return;
    }
    if (Notification.permission === 'denied') {
      pushToggleBtn.disabled = true;
      pushToggleBtn.textContent = 'Blockiert';
      pushStatusEl.textContent = overrideStatus ?? 'Benachrichtigungen sind für diese Seite in den Browser-Einstellungen blockiert.';
      return;
    }
    const sub = swRegistration ? await swRegistration.pushManager.getSubscription() : null;
    pushToggleBtn.disabled = false;
    pushToggleBtn.textContent = sub ? 'Deaktivieren' : 'Aktivieren';
    pushStatusEl.textContent = overrideStatus ?? (sub ? 'Aktiv — du bekommst Nachrichten auch, wenn diese Seite geschlossen ist.' : 'Aus.');
  }

  /**
   * Registriert (oder löscht, `subscription: null`) das Push-Abo beim
   * Relay — ein ganz normaler signierter Write, keine eigene
   * Protokoll-Nachricht: `push-subscription/<eigener Fingerprint>` ist ein
   * Space wie jeder andere auch (relay.mjs mountet dieses eine Präfix
   * dort auf einen NullAdapter, damit es beim Relay flüchtig bleibt statt
   * für immer gespeichert zu werden — dieselbe Idee wie Presence, siehe
   * dessen `reads`/`presence`-Pfade). `repl.sync()` danach (statt uns auf
   * das fire-and-forget `pushTopics`-Push zu verlassen) garantiert, dass
   * der Write das Relay auch WIRKLICH erreicht — derselbe Grund, aus dem
   * ensureAlias() das für das eigene Profil schon macht.
   */
  async function publishPushSubscription(subscription) {
    await qu.session.publish(`push-subscription/${qu.fingerprint}`, subscription);
    await repl.sync({ topic: `push-subscription/${qu.fingerprint}` }).catch((e) => console.error('[chat] push subscription sync failed:', e));
  }

  /** Beim Laden (nicht nur beim Klick auf den Button): ein bereits erteiltes Abo erneut ans Relay melden — dessen Zuordnung ist rein flüchtig (siehe publishPushSubscription()s Doku), ein Browser rotiert eine Subscription außerdem gelegentlich selbst. */
  async function initPush() {
    if (!pushSupported) { refreshPushUI(); return; }
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js');
    } catch (e) {
      console.error('[chat] service worker registration failed:', e);
      refreshPushUI();
      return;
    }
    if (Notification.permission === 'granted') {
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub) publishPushSubscription(sub.toJSON()).catch((e) => console.error('[chat] push re-register failed:', e));
    }
    refreshPushUI();
  }

  pushToggleBtn.addEventListener('click', async () => {
    pushToggleBtn.disabled = true;
    let errorStatus;
    try {
      const existing = swRegistration ? await swRegistration.pushManager.getSubscription() : null;
      if (existing) {
        await existing.unsubscribe();
        await publishPushSubscription(null).catch(() => {});
        return;
      }
      if (vapidPublicKey === undefined) {
        vapidPublicKey = await fetch('/push/vapid-public-key').then((r) => r.json()).then((r) => r.publicKey).catch(() => null);
      }
      if (!vapidPublicKey) {
        errorStatus = 'Push ist auf diesem Server nicht konfiguriert (QU_VAPID_PUBLIC_KEY fehlt).';
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const sub = await swRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) });
      await publishPushSubscription(sub.toJSON());
    } catch (e) {
      console.error('[chat] push toggle failed:', e);
      errorStatus = `Fehler: ${e.message}`;
    } finally {
      await refreshPushUI(errorStatus);
      pushToggleBtn.disabled = false;
    }
  });

  initPush();

  // --- Kontakt-hinzufügen-Modal ---
  const addContactModal = $('add-contact-modal');
  const contactFpInput = $('contact-fp-input');
  const contactAliasInput = $('contact-alias-input');
  const addContactError = $('add-contact-error');
  function openAddContactModal(prefillFp = '') {
    contactFpInput.value = prefillFp;
    contactAliasInput.value = '';
    addContactError.textContent = '';
    addContactModal.hidden = false;
    if (!prefillFp) contactFpInput.focus();
  }
  addContactBtn.addEventListener('click', () => openAddContactModal());
  $('add-contact-cancel-btn').addEventListener('click', () => { addContactModal.hidden = true; });
  addContactModal.addEventListener('click', (ev) => { if (ev.target === addContactModal) addContactModal.hidden = true; });
  $('add-contact-save-btn').addEventListener('click', async () => {
    const fp = normalizeFingerprint(contactFpInput.value);
    if (!fp) { addContactError.textContent = 'Ungültiger Fingerprint (24 Hex-Zeichen erwartet).'; return; }
    if (fp === qu.fingerprint) { addContactError.textContent = 'Das ist dein eigener Fingerprint.'; return; }
    if (contactByFp(fp)) { addContactModal.hidden = true; openContact(fp); return; }
    let alias = contactAliasInput.value.trim();
    if (!alias) {
      try { alias = (await qu.getProfile(fp)).alias ?? shortFp(fp); } catch { alias = shortFp(fp); }
    }
    upsertContact(fp, { alias, lastTs: 0, unread: 0 });
    renderContactList();
    addContactModal.hidden = true;
    openContact(fp);
  });

  // Einladungslink (#add=<fingerprint>) direkt beim Laden verarbeiten —
  // history.replaceState() räumt den `#add=...`-Hash IMMER zuerst weg
  // (auch im Modal-Fall, in dem noch gar kein Chat-Hash gesetzt wird),
  // damit ein anschließendes openContact() unten nicht seinen eigenen,
  // gerade erst gesetzten Chat-Hash (`#<fingerprint>`) wieder verliert.
  const invitedFp = parseInviteHash(location.hash);
  if (invitedFp && invitedFp !== qu.fingerprint) {
    history.replaceState(null, '', location.pathname);
    if (!contactByFp(invitedFp)) openAddContactModal(invitedFp);
    else openContact(invitedFp);
  } else {
    // Direktlink zu einem Chat (#<fingerprint>, siehe buildChatHashRoute()).
    const chatFp = parseChatHash(location.hash);
    if (chatFp && chatFp !== qu.fingerprint) openContactByHash(chatFp);
  }

  // --- Start ---
  renderContactList();
  for (const c of contacts) {
    ensureRoom(c.fp)
      .then(() => { if (!c.avatar) avatarFor(c.fp).then((url) => { if (url) renderContactList(); }); })
      .catch((e) => console.error('[chat] ensureRoom failed:', c.fp, e));
  }
  window.addEventListener('beforeunload', () => { for (const stop of stopHeartbeatByRoom.values()) stop(); });
}

main().catch((e) => {
  statusBar.textContent = `Fehler: ${e.message}`;
  statusBar.classList.add('err');
  console.error(e);
});
