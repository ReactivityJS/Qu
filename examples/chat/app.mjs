// 1:1-Privat-Chat, browserseitiger Teil (Identität, Kontaktliste in
// localStorage, Rendering, Lightbox, Emoji-Picker). Die Adress-/Format-
// Logik steckt bewusst NICHT hier, sondern in chat-lib.mjs (ohne `window`
// testbar) — derselbe Schnitt wie überall sonst im Repo. Netzwerk- und
// Nachrichten-Primitive kommen unverändert aus dem Core (src/modules/chat.js
// über createChatPlugin()) — diese Datei erfindet keine neue Chat-Logik,
// nur die Oberfläche darüber.

import {
  createNetworkPlugin, createSpacesPlugin, createFileHandlerPlugin,
  createChatPlugin, createWebSocketChannel, IndexedDBFileStorageAdapter, reassembleFile, readFileMeta,
  createWebRTCPlugin, sendRoutedEvent, onRoutedEvent, enableConsoleDebug,
  createSpaceMembershipPlugin, inboxId, createProfilesPlugin, DIRECTORY_ID,
} from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import {
  dmRoomId, groupRoomId, normalizeFingerprint, shortFp, fmtBytes, fmtTime, fmtDayLabel,
  linkify, mediaKind, sortByActivity, buildPath, parsePathSegments, fmtCallDuration,
} from './chat-lib.mjs';
import '../../src/ui/people-search-components.js'; // Seiteneffekt: registriert <qu-profile-card> (renderRoomHeader()/renderGroupMemberList()) UND <qu-people-search> (Neuer-Chat-Formular)

// Anruf-Diagnose: jede Signaling-/ICE-/Verbindungs-Phase eines Anrufs
// landet mit [webrtc:...]/[webrtc-pm:...]-Präfix in der Browser-Konsole
// (core/debug.js) — welche Kandidaten gesammelt wurden (host/srflx/relay,
// entscheidend für "geht's ohne TURN?"), ob ein Angebot/eine Antwort/ein
// ICE-Kandidat je den anderen erreicht (Signaling-Phase) oder ob
// Signaling durchläuft, aber die eigentliche P2P-Verbindung scheitert
// (Verbindungs-Phase). Immer an, nicht nur zum manuellen Debuggen — ein
// Nutzer, der Devtools öffnet (auch via chrome://inspect vom PC auf ein
// Android-Handy), sieht so ohne Codeänderung, an welcher Phase ein
// fehlgeschlagener Anruf tatsächlich hängt.
enableConsoleDebug({ filter: ['webrtc', 'webrtc-pm'] });

/**
 * Hält `--app-height` (style.css's .app) in Echtzeit auf der tatsächlich
 * sichtbaren Höhe — der robustere Nachschlag zu CSS' eigenem `100dvh`
 * (siehe dessen Kommentar dort), für Browser, bei denen `dvh` allein die
 * Bildschirmtastatur nicht zuverlässig einrechnet: ohne das kann Header/
 * Eingabeleiste unterhalb des sichtbaren Bereichs landen, sobald die
 * Tastatur aufklappt. `visualViewport` ist genau dafür da (reagiert live
 * auf Tastatur UND Adressleisten-Ein-/Ausblenden) — wo nicht verfügbar
 * (sehr alte Browser), bleibt einfach der CSS-`100dvh`-Fallback aktiv,
 * diese Funktion setzt dann schlicht nichts.
 * Setzt zusätzlich `window.scrollTo(0, 0)` bei jedem Aufruf — manche
 * mobilen Browser scrollen beim Fokussieren eines Eingabefelds nicht nur
 * die Tastatur rein, sondern die GESAMTE Seite ein Stück nach oben (natives
 * "scroll focused element into view"), obwohl `.app` selbst exakt
 * `--app-height` hoch ist und gar keinen eigenen Seiten-Scroll vorsieht —
 * genau das lässt Header/Eingabeleiste "mit rausscrollen". Ohne Gegenteil
 * bliebe dieser Seiten-Scroll-Versatz auch nach dem Fokussieren bestehen.
 */
function syncViewportHeight() {
  const vv = window.visualViewport;
  if (!vv) return;
  document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
  window.scrollTo(0, 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
  syncViewportHeight();
}

// Bewusst NICHT chat-eigen — dieselbe Identität soll über jede App auf
// diesem Ursprung (Origin, `localStorage` ist origin- nicht pfadgebunden)
// hinweg wiederverwendet werden, allen voran examples/people (globales
// Profil/Verzeichnis) — siehe dessen app.mjs, das denselben Key benutzt.
// Ein Fingerprint ist die eine zentrale Identität im gesamten Qu-Ökosystem,
// kein pro-App-Konto.
const IDENTITY_KEY = 'qu-identity';
const ALIAS_KEY = 'qu-chat-alias';
// CONTACTS: das Adressbuch (fp -> alias/avatar) — WER man kennt, nicht
// WELCHE Chats man hat. Ein Kontakt kann in mehreren Räumen vorkommen
// (ein 1:1 UND mehreren Gruppen mit derselben Person drin); die eigentliche
// Chat-Liste ist ROOMS (siehe ROOMS_KEY unten), nicht diese hier.
const CONTACTS_KEY = 'qu-chat-contacts';
// ROOMS: die eigentliche Chat-Liste — ein Eintrag pro Space, an dem dieses
// Gerät teilnimmt. Ein "Chat" ist technisch nichts anderes als ein Space
// mit einem ODER MEHREREN anderen Mitgliedern (siehe
// group-encryption.test.mjs: ein Space mit mehreren `readers`
// verschlüsselt automatisch für alle, ganz ohne Sonderfall) — 1:1
// (dmRoomId()) ist nur der Spezialfall mit genau einem anderen Mitglied,
// eine Gruppe (groupRoomId()) der allgemeine Fall mit einem eigenen Namen.
// Jeder Eintrag: `{ id (roomId), name (nur Gruppen — bei einem DM kommt
// der Anzeigename aus dem einzigen anderen Mitglieds-Kontakt), members
// (Fingerprints AUSSER einem selbst), lastTs, unread, lastPreview, lastMine }`.
const ROOMS_KEY = 'qu-chat-rooms';
// Stumm-/Verschlüsselungs-Einstellungen sind bewusst pro CHAT (roomId),
// nicht pro Kontakt (fp) — ein Kontakt kann in mehreren Räumen vorkommen,
// jeder davon soll unabhängig einstellbar sein.
const MUTED_ROOMS_KEY = 'qu-chat-muted-rooms';
const SOUND_MESSAGES_KEY = 'qu-chat-sound-messages';
const SOUND_CALLS_KEY = 'qu-chat-sound-calls';
const UNENCRYPTED_ROOMS_KEY = 'qu-chat-unencrypted-rooms'; // siehe isRoomEncrypted() weiter unten
const PENDING_DELIVERY_KEY = 'qu-chat-pending-delivery'; // siehe confirmDelivery() weiter unten
// Enger als modules/chat.js's eigene Defaults (8s/20s) — ein Kontakt soll
// sichtbar zügig als "offline" erkannt werden, nicht erst nach bis zu 20s
// Unschärfe. 3x Heartbeat als Stale-Schwelle lässt trotzdem genug
// Spielraum für einen einzelnen verpassten Tick (Netzwerk-Ruckler), ohne
// bei jedem kleinen Hänger fälschlich "offline" zu blinken.
const PRESENCE_HEARTBEAT_MS = 5_000;
const PRESENCE_STALE_MS = 15_000;

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const statusBar = $('status-bar');
const contactListEl = $('contact-list');
const emptyStateEl = $('empty-state');
const chatPanelEl = $('chat-panel');
const backBtn = $('back-btn');
const chatPeerIdentityEl = $('chat-peer-identity');
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
const newGroupBtn = $('new-group-btn');
const settingsBtn = $('settings-btn');
const chatSettingsBtn = $('chat-settings-btn');
const searchBtn = $('search-btn');

/**
 * Bis `main()` seine Verbindung zum Relay hergestellt UND das eigene
 * Profil geladen hat (mehrere sequenzielle `await`s — WebSocket-Verbinden,
 * Profil-Sync, …), sind die Klick-Handler dieser Buttons noch gar nicht
 * registriert (jeder `addEventListener()` dafür steht erst NACH diesen
 * `await`s im Code). Ein Klick in genau diesem Fenster war bisher ein
 * stiller No-Op — sah aus wie "die Suche/der Button funktioniert nicht",
 * war aber schlicht zu früh. `disabled` macht dieses Fenster jetzt SICHTBAR
 * (ausgegraut, siehe style.css's `:disabled`-Regeln) statt es unsichtbar
 * bleiben zu lassen — enableTopNav() unten schaltet sie frei, sobald
 * main() tatsächlich so weit ist.
 */
const TOP_NAV_BUTTONS = [meAvatarBtn, addContactBtn, newGroupBtn, settingsBtn, searchBtn];
for (const btn of TOP_NAV_BUTTONS) btn.disabled = true;
function enableTopNav() {
  for (const btn of TOP_NAV_BUTTONS) btn.disabled = false;
}
const searchOverlay = $('search-overlay');
const searchBackBtn = $('search-back-btn');
const searchInput = $('search-input');
const searchClearBtn = $('search-clear-btn');
const searchFiltersEl = document.querySelector('.search-filters');
const searchResultsEl = $('search-results');
const searchEmptyEl = $('search-empty');
const audioCallBtn = $('audio-call-btn');
const videoCallBtn = $('video-call-btn');
const soundMessagesToggle = $('sound-messages-toggle');
const soundCallsToggle = $('sound-calls-toggle');

// --- Screens/Modals — jeder ist ein eigener Router-Pfad, siehe main()s
// navigate()/renderRoute() weiter unten für das vollständige Pfadschema. ---
const profileModal = $('profile-modal');
const avatarPreviewBtn = $('avatar-preview-btn');
const avatarInput = $('avatar-input');
const appSettingsModal = $('app-settings-modal');
const pushToggleBtn = $('push-toggle-btn');
const pushStatusEl = $('push-status');
const addContactModal = $('add-contact-modal');
const contactFpInput = $('contact-fp-input');
const contactAliasInput = $('contact-alias-input');
const addContactError = $('add-contact-error');
const newGroupModal = $('new-group-modal');
const newGroupNameInput = $('new-group-name-input');
const newGroupContactListEl = $('new-group-contact-list');
const newGroupFpInput = $('new-group-fp-input');
const newGroupError = $('new-group-error');
const chatSettingsModal = $('chat-settings-modal');
const chatSettingsTitleEl = $('chat-settings-title');
const chatSettingsGroupSection = $('chat-settings-group-section');
const groupNameInput = $('group-name-input');
const groupMemberListEl = $('group-member-list');
const groupAddMemberInput = $('group-add-member-input');
const groupDetailsError = $('group-details-error');
const chatMuteToggle = $('chat-mute-toggle');
const chatEncryptionToggle = $('chat-encryption-toggle');
const chatEncryptionHint = $('chat-encryption-hint');
const chatDeleteBtn = $('chat-delete-btn');
const callOverlay = $('call-overlay');
const callAvatarEl = $('call-avatar');
const callPeerNameEl = $('call-peer-name');
const callStatusEl = $('call-status');
const callVideoArea = $('call-video-area');
const callRemoteVideo = $('call-remote-video');
const callLocalVideo = $('call-local-video');
const callIncomingActions = $('call-incoming-actions');
const callOutgoingActions = $('call-outgoing-actions');
const callConnectedActions = $('call-connected-actions');
const callAcceptBtn = $('call-accept-btn');
const callDeclineBtn = $('call-decline-btn');
const callCancelBtn = $('call-cancel-btn');
const callHangupBtn = $('call-hangup-btn');
const callMuteBtn = $('call-mute-btn');
const callCameraBtn = $('call-camera-btn');

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
// Sofort beim Fokussieren gegen den nativen "Seite scrollt mit hoch"-Effekt
// mobiler Browser gegensteuern (syncViewportHeight()s Doku oben) — nicht
// erst auf das (etwas später feuernde) visualViewport-'resize' warten.
textInput.addEventListener('focus', () => window.scrollTo(0, 0));

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

// --- Adressbuch (localStorage, per Fingerprint gepflegt — WER man kennt) ---
function loadContacts() {
  try { return JSON.parse(localStorage.getItem(CONTACTS_KEY)) ?? []; } catch { return []; }
}
function saveContacts(contacts) {
  localStorage.setItem(CONTACTS_KEY, JSON.stringify(contacts));
}
let contacts = loadContacts();
function upsertContact(fp, patch) {
  const i = contacts.findIndex((c) => c.fp === fp);
  if (i === -1) contacts.push({ fp, alias: shortFp(fp), ...patch });
  else contacts[i] = { ...contacts[i], ...patch };
  saveContacts(contacts);
}
function contactByFp(fp) {
  return contacts.find((c) => c.fp === fp) ?? null;
}

// --- Chat-/Raumliste (localStorage, siehe ROOMS_KEY oben — die eigentliche
// Chat-Liste, unabhängig vom Adressbuch) ---
function loadRooms() {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY)) ?? []; } catch { return []; }
}
function saveRooms(rooms) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms));
}
let rooms = loadRooms();
function roomById(id) {
  return rooms.find((r) => r.id === id) ?? null;
}
function upsertRoom(id, patch) {
  const i = rooms.findIndex((r) => r.id === id);
  if (i === -1) rooms.push({ id, name: null, members: [], lastTs: 0, unread: 0, ...patch });
  else rooms[i] = { ...rooms[i], ...patch };
  saveRooms(rooms);
}
function removeRoomEntry(id) {
  rooms = rooms.filter((r) => r.id !== id);
  saveRooms(rooms);
}
/** Ein DM (genau ein anderes Mitglied) oder eine Gruppe (mehrere)? */
function isGroupRoom(room) {
  return (room?.members?.length ?? 0) > 1;
}
/** Anzeigename: bei einer Gruppe ihr eigener Name, bei einem DM der Alias des einzigen anderen Mitglieds — nie leer, fällt am Ende auf eine gekürzte Fingerprint-Anzeige zurück. */
function roomDisplayName(room) {
  if (!room) return '';
  if (isGroupRoom(room)) return room.name || 'Gruppe';
  const peerFp = room.members[0];
  return contactByFp(peerFp)?.alias ?? shortFp(peerFp);
}
/** Avatar-Bild-URL fürs Rendern: bei einer Gruppe ihr eigenes (optionales) Bild, bei einem DM das des einzigen anderen Mitglieds. */
function roomDisplayAvatar(room) {
  if (!room) return null;
  if (isGroupRoom(room)) return room.avatar ?? null;
  return contactByFp(room.members[0])?.avatar ?? null;
}

// --- Stumm-Schaltung pro Chat (siehe MUTED_ROOMS_KEY oben) ---
function loadMutedRooms() {
  try { return new Set(JSON.parse(localStorage.getItem(MUTED_ROOMS_KEY)) ?? []); } catch { return new Set(); }
}
const mutedRooms = loadMutedRooms();
function isRoomMuted(roomId) { return mutedRooms.has(roomId); }
function setRoomMuted(roomId, muted) {
  if (muted) mutedRooms.add(roomId); else mutedRooms.delete(roomId);
  localStorage.setItem(MUTED_ROOMS_KEY, JSON.stringify([...mutedRooms]));
}

// --- Verschlüsselung pro Chat (Default: AN) ---
// core/session.js's Session#publish() verschlüsselt automatisch für
// exakt die `readers` eines Space, SOBALD `encryptFor` beim Schreiben
// weggelassen wird — ABER nur, wenn `readers` eine konkrete Liste ist,
// nicht der Platzhalter `['*']` (dessen eigene Doku: "encryptFor
// omitted... defaults to encrypting for exactly that list" bzw. bei
// `['*']` ein bewusstes No-Op). Ein DM-Raum hier nutzt `readers: ['*']`
// — nicht, weil er öffentlich lesbar sein SOLL, sondern weil ein Relay
// ein QuBit nur weiterleiten darf, wenn es selbst in dessen `readers`
// steht (siehe ensureRoom()), und `['*']` das ohne hartkodierten
// Relay-Fingerprint löst. Deshalb übergibt der Composer unten explizit
// `encryptFor: [eigener Fingerprint, Peer]` statt sich auf die
// automatische Ableitung zu verlassen — genau dieser explizite Aufruf
// ist der Schalter, den dieses Feature umlegt: `null` (siehe
// Session#publish()s eigene Doku: "explizit `null`/`[]` ist ein
// bewusster Opt-out") statt der Empfängerliste lässt die Nachricht
// unverschlüsselt, GENAU dort, wo `readers: ['*']` ohnehin schon
// erlaubt, dass sie jeder mit Lesezugriff auf den Space sieht (Relay
// eingeschlossen) — Schreiben bleibt weiterhin auf die Chat-Mitglieder
// beschränkt (`writers`), nur die Vertraulichkeit des INHALTS entfällt.
// Gilt NUR für die eigenen, künftigen Nachrichten dieses Geräts — jede
// Seite entscheidet für ihre eigenen Schreibvorgänge unabhängig, und
// bereits gesendete Nachrichten bleiben, wie sie geschrieben wurden.
function loadUnencryptedRooms() {
  try { return new Set(JSON.parse(localStorage.getItem(UNENCRYPTED_ROOMS_KEY)) ?? []); } catch { return new Set(); }
}
const unencryptedRooms = loadUnencryptedRooms();
function isRoomEncrypted(roomId) { return !unencryptedRooms.has(roomId); }
function setRoomEncrypted(roomId, encrypted) {
  if (encrypted) unencryptedRooms.delete(roomId); else unencryptedRooms.add(roomId);
  localStorage.setItem(UNENCRYPTED_ROOMS_KEY, JSON.stringify([...unencryptedRooms]));
}

// --- "Beim Relay angekommen?"-Status eigener Nachrichten (siehe
// confirmDelivery() weiter unten) ---
// Persistiert (nicht nur im Speicher), WEIL genau der Fall zählt, den
// dieses Feature adressiert: ein Upload, dessen Bestätigung noch nicht da
// war, als das Gerät ausgeschaltet/die Seite geschlossen wurde — ohne
// Persistenz würde der nächste Appstart einfach vergessen, dass da noch
// etwas unbestätigt in der Luft hängt, und die UI zeigte dauerhaft (fälschlich)
// "gesendet" statt es beim nächsten Verbindungsaufbau erneut zu prüfen.
function loadPendingDeliveries() {
  try { return JSON.parse(localStorage.getItem(PENDING_DELIVERY_KEY)) ?? []; } catch { return []; }
}
function savePendingDeliveries(list) {
  localStorage.setItem(PENDING_DELIVERY_KEY, JSON.stringify(list));
}

// --- Töne (Web Audio API, synthetisiert — kein externes Audio-Asset
// nötig, funktioniert also ohne jeden zusätzlichen Download/Lizenzfrage) ---
// Ein/Aus je Ereignistyp global (SOUND_MESSAGES_KEY/SOUND_CALLS_KEY,
// Default "an" bei fehlendem Eintrag), zusätzlich pro Chat stumm
// schaltbar (mutedRooms oben) — beides zusammen ergibt "Nachrichtenton
// an, aber dieser eine Chat stumm" ODER "dieser Chat nicht stumm, aber
// Töne insgesamt aus", unabhängig voneinander einstellbar.
function soundEnabled(key) { return localStorage.getItem(key) !== '0'; }
function setSoundEnabled(key, enabled) { localStorage.setItem(key, enabled ? '1' : '0'); }

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
  return audioCtx;
}
// Browser verweigern Audio-Wiedergabe ohne vorherige Nutzer-Interaktion
// (Autoplay-Policy) — ein einmaliger, früh registrierter Listener auf
// IRGENDEINE Interaktion "entsperrt" den AudioContext, lange bevor die
// erste Nachricht/der erste Anruf tatsächlich einen Ton braucht.
function primeAudioContext() { getAudioCtx().resume().catch(() => {}); }
document.addEventListener('pointerdown', primeAudioContext, { once: true });
document.addEventListener('keydown', primeAudioContext, { once: true });

/** Ein kurzer, weicher Zwei-Ton-Klang (Sinus, exponentiell ausklingend) — die Bausteine für sowohl den Nachrichten-Ping als auch den Klingelton unten. */
function playTone(freqs, { duration = 0.16, gain = 0.15, startOffset = 0 } = {}) {
  const ctx = getAudioCtx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  const now = ctx.currentTime + startOffset;
  for (const [i, freq] of freqs.entries()) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(gain, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(g).connect(ctx.destination);
    osc.start(now + i * 0.06);
    osc.stop(now + duration + 0.05);
  }
}

function playMessageSound() {
  if (!soundEnabled(SOUND_MESSAGES_KEY)) return;
  playTone([880, 1318.5], { duration: 0.18, gain: 0.12 }); // A5 -> E6, kurzer aufsteigender "Ping"
}

let ringtoneTimer = null;
function startRingtone() {
  if (!soundEnabled(SOUND_CALLS_KEY) || ringtoneTimer) return;
  const ring = () => playTone([659.25, 523.25], { duration: 0.5, gain: 0.14 }); // E5 -> C5, klassisches Zwei-Ton-Klingeln
  ring();
  ringtoneTimer = setInterval(ring, 1800);
}
function stopRingtone() {
  clearInterval(ringtoneTimer);
  ringtoneTimer = null;
}

async function main() {
  const qu = await loadOrCreateIdentity(IDENTITY_KEY);
  qu.use(createNetworkPlugin()).use(createSpacesPlugin()).use(createSpaceMembershipPlugin()).use(createProfilesPlugin()).use(createChatPlugin()).use(createWebRTCPlugin());
  // IndexedDB, nicht MemoryFileStorageAdapter — Anhänge (Bilder, Videos, …)
  // sollen nach dem ersten Herunterladen auch einen Reload überleben, statt
  // bei jedem Laden erneut vom Relay angefragt zu werden (renderAttachment()
  // unten prüft ohnehin schon hasComplete()/fragt nur fehlende Chunks nach —
  // mit einem rein-flüchtigen Adapter war "fehlend" nach jedem Reload aber
  // wieder alles).
  const localFileStorage = new IndexedDBFileStorageAdapter({ dbName: 'qu-chat-files' });
  qu.use(createFileHandlerPlugin({ fileStorage: localFileStorage }));

  registerServiceWorker(); // so früh wie möglich, unabhängig von der restlichen Chat-Initialisierung — siehe dessen Doku oben

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

  // --- "Beim Relay angekommen?"-Status eigener Nachrichten ---
  // Vor connectToRelay() deklariert (das confirmDelivery() weiter unten
  // schon beim allerersten Verbindungsaufbau aufruft) — als `let`
  // deklarierte Bindungen sind NICHT wie Funktionsdeklarationen gehoben,
  // eine spätere Deklaration hier würde bei diesem ersten Aufruf mit einem
  // "Cannot access before initialization" (TDZ) crashen.
  //
  // deliveredMsgIds: welche (dieser Session bekannten) eigenen Nachrichten
  // bereits BESTÄTIGT beim Relay angekommen sind (Uhr-Symbol → einfacher
  // Haken). pendingDeliveries (aus localStorage vorbefüllt, siehe
  // PENDING_DELIVERY_KEY oben) ist die Kehrseite: eigene Nachrichten, die
  // NOCH NICHT bestätigt sind — nur diese zeigen überhaupt das Uhr-Symbol,
  // jede ältere/unbekannte eigene Nachricht gilt stillschweigend als
  // "gesendet" (renderTicks() weiter unten), genau wie vor diesem Feature.
  const deliveredMsgIds = new Set();
  let pendingDeliveries = loadPendingDeliveries();

  /**
   * Prüft für EINE eigene Nachricht (+ ihre Anhänge), ob sie inzwischen
   * beim Relay angekommen ist — über die neue DefaultReplication#
   * waitUntilReplicated() (für die Nachricht selbst) und die schon
   * bestehende DefaultFileTransfer#waitUntilReady() (für jeden Anhang:
   * "hat der Relay wirklich ALLE Chunks", nicht nur das Manifest). Beide
   * pollen mit Backoff über das Netzwerk — kein blindes UI-Polling, nur
   * EIN Aufruf pro (Wieder-)Verbindung (siehe connectToRelay()) oder
   * direkt nach dem Senden. Läuft die Wartezeit ab, OHNE dass
   * connectToRelay() zwischenzeitlich fehlschlug, bleibt der Eintrag
   * einfach in pendingDeliveries stehen — der nächste Reconnect versucht
   * es erneut, unbegrenzt, bis es klappt oder der Nutzer den Chat löscht.
   */
  async function confirmDelivery(entry) {
    if (deliveredMsgIds.has(entry.id)) return;
    if (!channel?.isOpen()) return; // nichts zu prüfen gerade — nächster Reconnect versucht es erneut
    try {
      const msgOk = await repl.waitUntilReplicated(entry.id, { ts: entry.ts, maxWaitMs: 20000 });
      if (!msgOk) return;
      for (const ref of entry.refs ?? []) {
        const ready = await fileTransfer.waitUntilReady(ref, { maxWaitMs: 20000 });
        if (!ready) return;
      }
    } catch (e) {
      console.error('[chat] confirmDelivery fehlgeschlagen:', entry.id, e);
      return;
    }
    deliveredMsgIds.add(entry.id);
    pendingDeliveries = pendingDeliveries.filter((p) => p.id !== entry.id);
    savePendingDeliveries(pendingDeliveries);
    if (activeRoomId === entry.roomId) renderTicks(entry.roomId);
  }

  // Service Worker: unabhängig von Push registriert (s. registerServiceWorker()
  // unten) — er ist zusammen mit manifest.webmanifest die eigentliche
  // Installierbarkeits-Voraussetzung (Add to Home Screen / Desktop-
  // Installation), Push-Benachrichtigungen sind nur EINE Sache, die er
  // zusätzlich kann. `null`, solange die Registrierung noch läuft oder
  // fehlgeschlagen ist (z. B. Browser ohne Service-Worker-Unterstützung).
  let swRegistration = null;
  /** Wird früh in main() aufgerufen (unten), unabhängig von pushSupported — auf z. B. iOS Safari fehlt PushManager, "Zum Home-Bildschirm hinzufügen" funktioniert (über Safaris eigenen Mechanismus, nicht den Chrome-Installations-Prompt) trotzdem, sobald Manifest + Service Worker da sind. */
  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      swRegistration = await navigator.serviceWorker.register('./sw.js');
    } catch (e) {
      console.error('[chat] service worker registration failed:', e);
    }
    return swRegistration;
  }

  // Anruf-Zustand (siehe der ausführliche Kommentar im Anruf-Abschnitt
  // weiter unten) — hier oben deklariert, weil setupCallSignaling()
  // schon beim ALLERERSTEN connectToRelay()-Aufruf gleich unten zuweist.
  let webrtcManager = null;
  // Vom Server abgefragte ICE-Server (index.js's QU_TURN_URLS etc., über
  // /webrtc/ice-servers, server/webrtc-routes.mjs) — `null` bis geladen,
  // dann entweder das konfigurierte Set oder `undefined` (Server hat
  // nichts Eigenes konfiguriert, createWebRTCChannel()s STUN-only-Default
  // greift). Ein reiner STUN-Server reicht nur, wenn mindestens eine Seite
  // direkt/STUN-reflexiv erreichbar ist — hinter Mobilfunk-NAT o. Ä. ohne
  // TURN bleibt ein Anruf sonst bei "verbindet …" hängen (siehe
  // endCall()s Hinweistext für den Nutzer).
  let iceServers;
  // { peerFp, kind: 'audio'|'video', direction: 'incoming'|'outgoing',
  //   state: 'ringing'|'connecting'|'connected', callerAlias, localStream,
  //   remoteStream, pc, channel, startedAt, ringTimeout, timerInterval }
  let activeCall = null;
  const pendingCallDecisions = new Map(); // fp -> resolve(opts|null), ein Eintrag pro gerade klingelndem eingehendem Anruf
  const RING_TIMEOUT_MS = 45_000;
  const CALL_CONNECT_FAILED_MSG = 'Anruf fehlgeschlagen — keine Verbindung zustande gekommen (evtl. Netzwerk-/NAT-Problem; falls das öfter passiert, braucht dieser Server einen TURN-Server, siehe QU_TURN_URLS).';
  const ensuredRooms = new Set(); // roomId, schon abonniert/erstellt (siehe ensureRoom())

  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function connectToRelay() {
    // Ein eigener, lokaler `attempt`-Channel statt direkt in `channel` zu
    // schreiben — verhindert, dass ein GESCHEITERTER Versuch das
    // weiterhin funktionierende alte `channel` überschreibt, und lässt
    // uns den hängengebliebenen Versuch unten wirklich schließen statt
    // ihn nur zu verwerfen.
    const attempt = createWebSocketChannel(relayUrl());
    try {
      // `channel.connect()` selbst hat kein eingebautes Timeout — im
      // schlimmsten Fall (Netz technisch "da", aber tot: Flugmodus-artige
      // Situationen, ein Router, der Pakete kommentarlos verwirft) hängt
      // der native WebSocket-Verbindungsversuch auf unbestimmte Zeit in
      // CONNECTING, ohne je 'open' oder 'error' zu feuern. Ohne dieses
      // Race bliebe `reconnecting` unten für immer `true` — kein
      // Zeitüberschreitungs-Fehler bedeutet ohne dieses Race auch kein
      // erneuter Versuch, jemals wieder, genau das Symptom "reconnect
      // bleibt im Hintergrund hängen".
      await Promise.race([
        attempt.connect(),
        wait(10000).then(() => { throw new Error('Zeitüberschreitung beim Verbindungsaufbau'); }),
      ]);
    } catch (e) {
      attempt.close().catch(() => {});
      throw e;
    }
    channel = attempt;
    // '' als Präfix (matcht jede Id) — Räume entstehen dynamisch per
    // Kontakt (dmRoomId()), ihre Id steht beim Verbinden nicht fest;
    // Gegenstück zum Relay's eigenem allowDynamicSubscribe (README,
    // "Ein App-unabhängiger Relay") — was WIR selbst schreiben, pushen wir
    // immer, unabhängig vom Topic.
    repl = await qu.connect(channel, { pushTopics: [''] });
    fileTransfer = qu.fileTransfer(channel, localFileStorage);
    // NUR im Vordergrund automatisch neu verbinden: relay.mjs entscheidet
    // "schon online, kein Push nötig" allein danach, ob unser WebSocket
    // noch offen ist (`connected`-Map) — würden wir im Hintergrund sofort
    // wieder neu verbinden, bliebe dieser Fingerprint für das Relay
    // dauerhaft "online", obwohl niemand da ist, der die Nachricht sieht,
    // und Push würde nie ausgelöst (genau das gemeldete "Aktivierung
    // gelingt, aber Push kommt nicht an", wenn der Tab im Hintergrund
    // hängt statt sauber getrennt zu werden). Sichtbar wird ohnehin schon
    // per visibilitychange unten neu verbunden.
    channel.onClose(() => { if (document.visibilityState === 'visible') scheduleReconnect(); });
    statusBar.textContent = 'Verbunden';
    statusBar.classList.remove('err');
    reconnectAttempt = 0;
    // Nach jedem (Wieder-)Verbinden alle bereits bekannten Räume UND den
    // eigenen Briefkasten (space-membership.js's inboxId()) erneut abonnieren —
    // eine neue repl-Instanz kennt keine vorherigen Topics.
    repl.ensureSynced(`${inboxId(qu.fingerprint)}/requests`).catch((e) => console.error('[chat] inbox re-watch failed:', e));
    for (const roomId of ensuredRooms) {
      repl.ensureSynced(roomId).catch((e) => console.error('[chat] re-watch failed:', roomId, e));
      for (const fp of roomById(roomId)?.members ?? []) {
        repl.ensureSynced(`~${fp}/avatar`).catch((e) => console.error('[chat] avatar re-watch failed:', fp, e));
      }
    }
    setupCallSignaling(channel); // siehe Anruf-Abschnitt weiter unten — an JEDEN (neuen) Channel neu gebunden

    // Jede noch unbestätigte eigene Nachricht (auch über einen App-Neustart
    // hinweg, siehe pendingDeliveries' Initialisierung aus localStorage)
    // erneut prüfen — deckt genau den Fall ab, dass die Bestätigung beim
    // letzten Mal nicht mehr rechtzeitig ankam, bevor die Verbindung/App
    // beendet wurde (siehe confirmDelivery()'s Doku).
    for (const entry of pendingDeliveries) confirmDelivery(entry).catch(() => {});
  }

  function scheduleReconnect() {
    if (reconnecting) return;
    reconnecting = true;
    reconnectAttempt++;
    const delayMs = Math.min(1000 * 2 ** (reconnectAttempt - 1), 15000);
    statusBar.textContent = `Verbindung getrennt — neuer Versuch in ${Math.round(delayMs / 1000)}s …`;
    statusBar.classList.add('err');
    setTimeout(async () => {
      let ok = false;
      try { await connectToRelay(); ok = true; } catch (e) {
        console.error('[chat] reconnect failed:', e);
        statusBar.textContent = `Wiederverbindung fehlgeschlagen (${e.message})`;
      } finally { reconnecting = false; }
      // Vorher brach die Retry-Schleife nach GENAU EINEM fehlgeschlagenen
      // Versuch endgültig ab (kein erneutes scheduleReconnect() im
      // Fehlerfall) — blieb die Seite danach im Hintergrund, ohne einen
      // weiteren 'online'/visibilitychange-Trigger, war die Verbindung
      // dauerhaft tot. `reconnecting` ist an dieser Stelle (nach der
      // finally oben) garantiert schon wieder `false`, der Aufruf hier
      // löst also wirklich einen neuen, länger zurückgestellten Versuch
      // aus statt an der Guard-Prüfung oben abzuprallen.
      if (!ok) scheduleReconnect();
    }, delayMs);
  }

  iceServers = await fetch('/webrtc/ice-servers').then((r) => r.json()).then((r) => r.iceServers).catch(() => undefined);

  await connectToRelay();
  myAlias = await ensureAlias();
  meNameEl.textContent = myAlias;
  setAvatar(meAvatarBtn, myAlias);
  myAvatar = (await qu.get(`~${qu.fingerprint}/avatar`))?.value ?? null;
  if (myAvatar) setAvatar(meAvatarBtn, myAlias, myAvatar);
  enableTopNav(); // siehe dessen Doku oben — ab hier existieren `repl`/`myAlias` wirklich, jeder Klick-Handler unten funktioniert jetzt tatsächlich

  // Eigenen Briefkasten abonnieren (siehe ensureRoom()s Ping unten) — ein
  // von einem Kontakt remote gestarteter Chat taucht dadurch von selbst
  // auf, ganz ohne dass wir ihn zuerst hinzugefügt haben müssten. Erst
  // NACH connectToRelay() registrieren: `.map()`s Netzwerk-Subscribe
  // (README, "ensureSynced() ... automatisch, sobald ein node.on/map
  // aktiviert wird") braucht eine bereits aktive Verbindung, sonst läuft
  // es beim allerersten Aufruf ins Leere.
  qu.onSpaceInvite((q) => handleInboxRequest(q));

  // Nach einer Weile im Hintergrund die Verbindung aktiv trennen — siehe
  // Kommentar bei channel.onClose() oben: ein Mobil-Browser hält einen
  // WebSocket im Hintergrund oft noch minutenlang technisch offen (OS
  // friert erst später ein/killt ihn), das Relay hielte uns so lange
  // fälschlich für "live erreichbar" und würde Push zurückhalten. Kurze
  // Tab-Wechsel (< BACKGROUND_DISCONNECT_MS) werfen die Verbindung NICHT
  // weg — der Timer wird beim Wieder-Sichtbarwerden einfach abgebrochen.
  const BACKGROUND_DISCONNECT_MS = 20_000;
  let backgroundCloseTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (backgroundCloseTimer) { clearTimeout(backgroundCloseTimer); backgroundCloseTimer = null; }
      if (!reconnecting && !channel.isOpen()) scheduleReconnect();
    } else if (!backgroundCloseTimer) {
      backgroundCloseTimer = setTimeout(() => {
        backgroundCloseTimer = null;
        if (document.visibilityState !== 'visible' && channel?.isOpen()) {
          // Explizit "offline" veröffentlichen, SOLANGE der Kanal noch
          // offen ist — anders als beim eigentlichen close() unten kommt
          // das dann als ganz normales, sofortiges Live-Ereignis bei
          // jedem an, der gerade zuschaut (onPresenceChange()), statt
          // dass Kontakte erst nach Ablauf des Stale-Fensters (getPresence()s
          // staleAfterMs) merken, dass wir weg sind. Den Heartbeat-Timer
          // selbst NICHT stoppen (kein stopHeartbeatByRoom-Aufruf hier) —
          // der soll beim Wieder-Sichtbarwerden/Reconnect von selbst
          // weiterlaufen, sobald der nächste Tick wieder einen offenen
          // Kanal vorfindet, ganz ohne dass hier extra etwas neu gestartet
          // werden müsste.
          for (const roomId of ensuredRooms) qu.setPresence(roomId, 'offline').catch(() => {});
          channel.close().catch(() => {});
        }
      }, BACKGROUND_DISCONNECT_MS);
    }
  });
  window.addEventListener('online', () => { if (!reconnecting && !channel.isOpen()) scheduleReconnect(); });

  // --- Pro-Raum-Zustand (alle Maps roomId-geschlüsselt — EIN Raum kann
  // 1:1 ODER Gruppe sein, siehe ROOMS_KEY oben; der Code hier unterscheidet
  // beide nicht mehr) ---
  const messagesByRoom = new Map(); // roomId -> QuBit[]
  const seenIdsByRoom = new Map(); // roomId -> Set<id>  (Reconnect-Redelivery-sicher)
  const receiptsByRoom = new Map(); // roomId -> { [fingerprint]: upToTs }
  const stopHeartbeatByRoom = new Map(); // roomId -> stop()
  const presenceStaleTimerByRoom = new Map(); // roomId -> Timeout, siehe renderPresence()
  const unsubsByRoom = new Map(); // roomId -> Array<() => void>, siehe ensureRoom()/deleteRoom()
  // Pro-IDENTITÄT (nicht pro Raum) — bleibt fp-geschlüsselt, ein Alias/
  // Avatar gehört zur Person, nicht zu einem bestimmten Chat mit ihr.
  const aliasCache = new Map([[qu.fingerprint, myAlias]]);
  const avatarCache = new Map(); // fp -> dataUrl | null (null = bekannt abwesend, nicht "noch nicht geprüft")
  let activeRoomId = null;

  // --- Router ---
  // EIN Ort übersetzt `location.hash` in "welcher Screen ist offen"
  // (renderRoute()), EIN Ort navigiert dorthin (navigate()) — nirgendwo
  // sonst schaltet Code direkt ein `.hidden`/eine CSS-Klasse eines
  // Screens um. Der Hash IST der Zustand, jeder Screen zieht seine
  // Sichtbarkeit ausschließlich davon ab (dasselbe reaktive Prinzip wie
  // überall sonst in dieser App — Nachrichten/Presence/... —, hier nur
  // auf "welcher Screen ist offen" angewandt).
  //
  // Pfadschema (chat-lib.mjs's buildPath()/parsePathSegments(); das erste
  // Segment entscheidet — die festen Namen unten kollidieren nie mit
  // einer echten Raum-Id, die immer mit `dm-`/`grp-` beginnt):
  //   /                    Chatliste
  //   /profile             eigenes Profil
  //   /settings            App-Einstellungen
  //   /search              Suche über alle Chats
  //   /add-contact[/<fp>]  neuer 1:1-Chat per Fingerprint, optional
  //                        vorausgefüllt — ein geteilter Einladungslink
  //                        ist einfach diese Route mit gesetztem <fp>,
  //                        kein eigenes Link-Format mehr.
  //   /new-group           neue Gruppe
  //   /<roomId>            ein Chat
  //   /<roomId>/settings   dessen Einstellungen (Stumm/Verschlüsselung/
  //                        [Gruppe: Umbenennen/Mitglieder]/Löschen)
  //
  // Jede Navigation läuft über location.hash = ... (navigate()), das
  // erzeugt von selbst einen Browser-Verlaufseintrag UND feuert
  // 'hashchange' — kein manuelles history.pushState() nötig. closeScreen()
  // nutzt deshalb einfach history.back(): main()s Start (siehe ganz unten)
  // garantiert per history.replaceState(), dass unter einem tief
  // verlinkten Screen IMMER die Chatliste liegt, "zurück" verlässt die
  // App also nie, selbst wenn die Seite direkt über einen Chat-/
  // Einstellungs-Link geöffnet wurde.
  async function navigate(...segments) {
    const hash = segments.length ? buildPath(...segments) : '#/';
    if (location.hash === hash) return renderRoute();
    location.hash = hash; // setzt location.hash SOFORT (synchron lesbar) — nur das zugehörige 'hashchange'-Event feuert erst asynchron, siehe renderRoute()s Dedup-Wächter
    return renderRoute();
  }

  /** Wie navigate(), aber OHNE neuen Verlaufseintrag — für Umleitungen (z. B. ein unbekannter Raum in der URL), die "zurück" nicht als eigenen Schritt zählen sollen. */
  async function redirectTo(...segments) {
    const hash = segments.length ? buildPath(...segments) : '#/';
    history.replaceState(null, '', location.pathname + hash);
    return renderRoute();
  }

  /** Schließt den aktuell offenen Screen — jede Navigation hierher lief über navigate(), hat also einen Verlaufseintrag hinterlassen; ein echtes Browser-"Zurück" statt eines eigenen "vorherigen Screen"-Stapels. */
  function closeScreen() {
    history.back();
  }

  function hideAllScreens() {
    appEl.classList.remove('chat-open');
    emptyStateEl.classList.remove('show');
    chatPanelEl.classList.add('hidden-empty');
    profileModal.hidden = true;
    appSettingsModal.hidden = true;
    searchOverlay.hidden = true;
    addContactModal.hidden = true;
    newGroupModal.hidden = true;
    chatSettingsModal.hidden = true;
  }

  const ROOT_ROUTES = {
    profile: () => showProfileScreen(),
    settings: () => showAppSettingsScreen(),
    search: () => showSearchScreen(),
    'add-contact': (prefillFp) => showAddContactScreen(prefillFp),
    'new-group': () => showNewGroupScreen(),
  };

  // navigate()/redirectTo() rendern SOFORT synchron (damit ein Aufrufer
  // z. B. "Raum öffnen, DANN zu einer Nachricht scrollen" korrekt
  // nacheinander ablaufen lassen kann, siehe openSearchResult()) — das
  // spätere, tatsächliche 'hashchange'-Event für GENAU denselben Hash
  // würde also ein zweites Mal rendern, rein event-getrieben (z. B.
  // Browser-Vor-/Zurück) macht das nichts, doppelt für denselben Hash ist
  // aber unnötige Arbeit. `lastRenderedHash` merkt sich den zuletzt
  // gerenderten Hash und überspringt eine Wiederholung dafür.
  let lastRenderedHash = null;
  async function renderRoute() {
    if (location.hash === lastRenderedHash) return;
    lastRenderedHash = location.hash;
    const segments = parsePathSegments(location.hash);
    hideAllScreens();
    if (!segments.length) { showChatListScreen(); return; }
    const [first, second, third] = segments;
    if (ROOT_ROUTES[first]) { await ROOT_ROUTES[first](second); return; }
    const room = roomById(first);
    if (!room) { await redirectTo(); return; } // unbekannte/fremde Raum-Id -> zurück zur Chatliste, kein Verlaufseintrag dafür
    if (second === 'settings') { showChatSettingsScreen(room); return; }
    // `/<roomId>/msg/<messageId>` — Direktlink auf eine einzelne Nachricht
    // (z. B. geteilt aus der Suche, siehe openSearchResult()): öffnet den
    // Chat wie sonst auch (der startet regulär ganz unten, siehe
    // renderMessageList()s Doku), springt DANACH zu genau dieser Nachricht
    // und hebt sie kurz hervor — derselbe Sprung-Mechanismus wie ein
    // Klick auf ein Suchergebnis, nur jetzt auch direkt über die URL
    // erreichbar/teilbar.
    if (second === 'msg' && third) { await showChatScreen(room); scrollToMessage(third); return; }
    await showChatScreen(room);
  }
  window.addEventListener('hashchange', renderRoute);

  /**
   * `true`, wenn `alias` noch nicht aus dem Netzwerk aufgelöst wurde —
   * `upsertContact()`s eigener Platzhalter-Default beim Anlegen eines
   * Kontakts IST `shortFp(fp)` (siehe dort), genau deshalb taugt der
   * Vergleich als "noch unbekannt"-Marker, ganz ohne ein separates Flag.
   */
  function isAliasUnresolved(fp, alias) {
    return !alias || alias === shortFp(fp);
  }

  /**
   * Der Alias eines Mitglieds — reaktiv per Live-Abo in ensureRoom()
   * gehalten, sobald ein Chat mit ihm einmal geöffnet wurde/ist; diese
   * Funktion ist der Nachlade-Weg für den Moment DAVOR (Kontakt gerade
   * erst hinzugefügt, `rooms`-Liste noch vor dem ersten Öffnen gerendert),
   * exakt dasselbe Muster wie avatarFor() für den Avatar. Ein explizit vom
   * User gesetzter Alias (`contact.aliasCustom`, siehe add-contact-Formular
   * unten) gewinnt immer und wird nie durch einen Netzwerk-Wert überschrieben.
   */
  async function aliasFor(fp) {
    if (fp === qu.fingerprint) return myAlias;
    const contact = contactByFp(fp);
    if (contact?.aliasCustom) return contact.alias;
    if (contact?.alias && !isAliasUnresolved(fp, contact.alias)) return contact.alias;
    if (aliasCache.has(fp)) return aliasCache.get(fp);
    try {
      const profile = await qu.readProfile(fp);
      const name = profile.alias ?? shortFp(fp);
      aliasCache.set(fp, name);
      if (contact) upsertContact(fp, { alias: name });
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

  /**
   * Stellt sicher, dass ein bereits in `rooms` (localStorage, ROOMS_KEY
   * oben) bekannter Raum lokal abonniert/gebootstrapt ist — ein DM (ein
   * anderes Mitglied) UND eine Gruppe (mehrere) laufen durch exakt
   * denselben Code, kein Sonderfall pro Mitgliederzahl. `roomId` muss
   * vorher per upsertRoom() (über startDm()/createGroupRoom()/
   * handleInboxRequest() unten) eingetragen worden sein.
   */
  async function ensureRoom(roomId) {
    if (ensuredRooms.has(roomId)) return roomId;
    const room = roomById(roomId);
    if (!room) throw new Error(`[chat] ensureRoom(): unbekannter Raum ${roomId}`);
    ensuredRooms.add(roomId);
    messagesByRoom.set(roomId, []);
    seenIdsByRoom.set(roomId, new Set());

    const unsubs = [];
    unsubsByRoom.set(roomId, unsubs);
    unsubs.push(qu.onMessage(roomId, (q) => handleIncomingMessage(roomId, q)));
    unsubs.push(qu.onPresenceChange(roomId, async () => renderPresence(roomId)));
    unsubs.push(qu.onReadReceipt(roomId, async () => {
      receiptsByRoom.set(roomId, await qu.getReadReceipts(roomId));
      if (activeRoomId === roomId) renderTicks(roomId);
    }));
    // Gruppenname: ein normaler LWW-Wert AM Raum selbst (`${roomId}/meta`),
    // nicht nur lokal in `rooms` — jede Umbenennung (renameGroupRoom()
    // unten) synct so automatisch zu jedem Mitglied, genau wie Alias/
    // Presence. Bei einem DM bleibt dieser Knoten schlicht ungenutzt
    // (roomDisplayName() liest den Namen dort ohnehin nie für einen DM).
    unsubs.push(qu.get(roomId).get('meta').on((q) => {
      if (typeof q?.value?.name !== 'string') return;
      upsertRoom(roomId, { name: q.value.name });
      if (activeRoomId === roomId) renderRoomHeader(roomById(roomId));
      renderRoomList();
    }));

    // JEDES andere Mitglieds Userspace (pub/epub/alias, immer öffentlich
    // lesbar — core/space.js's RESERVED_PROFILE_PATHS) VOR dem Raum selbst
    // syncen: sendMessage() unten verschlüsselt explizit für ALLE
    // Mitglieder (encryptFor) und braucht dafür den ECDH-Public-Key jedes
    // Empfängers bereits lokal bekannt (core/session.js's
    // #resolveRecipientKey()) — sonst schlägt das allererste Senden fehl,
    // falls das lokale Store frisch ist (z. B. nach einem Reload). Bei
    // einem DM ist das genau EIN Mitglied, bei einer Gruppe mehrere.
    for (const memberFp of room.members) {
      await repl.sync({ topic: `~${memberFp}` }).catch((e) => console.error('[chat] peer profile sync failed:', memberFp, e));
      // Live-Abo auf Avatar UND Alias (nicht nur der einmalige Sync oben) —
      // ändert ein Mitglied sein Profilbild oder seinen Anzeigenamen,
      // während der Chat schon offen ist, muss das sofort ankommen, genau
      // wie Presence bereits live ist. `.on()` liefert per Default nur
      // ZUKÜNFTIGE Änderungen (kein initial: true wie map(),
      // core/space-handle.js's on()-Doku) — der aktuelle Stand kommt beim
      // ersten Öffnen stattdessen über aliasFor()/avatarFor()s Nachladeweg.
      unsubs.push(qu.get(`~${memberFp}`).get('avatar').on((q) => {
        const url = q?.value ?? null;
        avatarCache.set(memberFp, url);
        upsertContact(memberFp, { avatar: url });
        if (activeRoomId === roomId) renderRoomHeader(room);
        renderRoomList();
      }));
      // Ein explizit vom User gesetzter Alias (aliasCustom, siehe
      // add-contact-Formular) ist ein bewusstes lokales Override und wird
      // NIE durch einen entfernten Alias-Wert überschrieben — sonst gäbe
      // es genau den Sonderfall, den ein einheitliches "immer reaktiv den
      // Alias nehmen" vermeiden soll.
      unsubs.push(qu.get(`~${memberFp}`).get('alias').on((q) => {
        if (contactByFp(memberFp)?.aliasCustom) return;
        const name = q?.value ?? shortFp(memberFp);
        aliasCache.set(memberFp, name);
        upsertContact(memberFp, { alias: name });
        if (activeRoomId === roomId) renderRoomHeader(roomById(roomId));
        renderRoomList();
      }));
    }
    await repl.ensureSynced(roomId);

    // Manifest-Bootstrap (falls noch keins existiert) — src/modules/
    // space-membership.js's ensureSpace(), nicht chat-spezifisch: dieselbe
    // Space+Mitgliederschaft-Logik, die jede andere Space-basierte App
    // (ToDo, Forum, CMS) genauso braucht. `readers: ['*']` (der Default)
    // ist bewusst OFFEN, nicht auf die Mitglieder beschränkt — siehe dessen
    // Doku: ein Relay darf ein QuBit nur weiterleiten, wenn es selbst in
    // dessen `readers` steht. Die eigentliche Privatsphäre kommt aus
    // Verschlüsselung (sendMessage()s `encryptFor` unten).
    await qu.ensureSpace(roomId, room.members);

    receiptsByRoom.set(roomId, await qu.getReadReceipts(roomId));
    renderPresence(roomId);
    stopHeartbeatByRoom.set(roomId, qu.startHeartbeat(roomId, { intervalMs: PRESENCE_HEARTBEAT_MS }));

    // In den Briefkasten (space-membership.js's inboxId()) JEDES anderen
    // Mitglieds schreiben, damit ein von UNS gestarteter Chat spätestens
    // jetzt (nicht erst mit der ersten Nachricht) bei jedem auftaucht, ohne
    // dass irgendwer ihn zuerst selbst hätte hinzufügen müssen —
    // notifyMembers() schickt jedem Mitglied seine EIGENE Mitgliederliste
    // (alle AUSSER sich selbst) mit, damit sein handleInboxRequest()/
    // ensureRoom() denselben Raum mit denselben Mitgliedern anlegt.
    await qu.notifyMembers(roomId, room.members, { alias: myAlias, name: room.name ?? null });

    return roomId;
  }

  /**
   * Startet (oder öffnet, falls schon vorhanden) einen 1:1-Chat mit
   * `peerFp` — der vereinfachte Spezialfall von createGroupRoom() mit
   * genau einem Mitglied UND einer deterministischen statt zufälligen
   * Raum-Id (dmRoomId()), damit beide Seiten unabhängig auf demselben
   * Raum landen, ohne vorher einen Link austauschen zu müssen.
   */
  async function startDm(peerFp) {
    const roomId = dmRoomId(qu.fingerprint, peerFp);
    if (!roomById(roomId)) upsertRoom(roomId, { name: null, members: [peerFp] });
    await ensureRoom(roomId);
    return roomId;
  }

  /** Legt einen neuen Gruppen-Chat mit `memberFps` unter dem Namen `name` an — der allgemeine Fall, dessen Spezialfall (genau ein Mitglied) startDm() oben ist. */
  async function createGroupRoom(name, memberFps) {
    const roomId = groupRoomId();
    upsertRoom(roomId, { name, members: [...memberFps] });
    await ensureRoom(roomId);
    // Name kanonisch im Raum selbst hinterlegen (siehe ensureRoom()s
    // `meta`-Abo oben) — die eigene `rooms`-Kopie oben ist bereits gesetzt
    // (optimistisch, für die eigene sofortige Anzeige), das hier ist, was
    // JEDES ANDERE Mitglied beim Sync tatsächlich sieht.
    await qu.get(roomId).get('meta').put({ name }).catch((e) => console.error('[chat] group name publish failed:', roomId, e));
    return roomId;
  }

  /**
   * Benennt eine bestehende Gruppe um — schreibt nur den `meta`-Knoten
   * (siehe ensureRoom()s Abo darauf); die lokale `rooms`-Kopie zieht über
   * genau dieses Abo nach, auch bei UNS selbst, kein doppelter Code-Pfad
   * für "eigene Umbenennung" vs. "von jemand anderem umbenannt bekommen".
   */
  async function renameGroupRoom(roomId, name) {
    await qu.get(roomId).get('meta').put({ name });
  }

  /**
   * Fügt `newFp` zu einer bestehenden Gruppe hinzu — Schreib-/Admin-Rolle
   * im Space-Manifest (readers bleibt `['*']`, siehe ensureRoom()s Doku)
   * UND die lokale Mitgliederliste. Kein separater ensureRoom()-Aufruf
   * hier (der wäre wegen `ensuredRooms`s Guard sofort ein No-Op) — dieselbe
   * Profil-Sync-/Avatar-Abo-/Briefkasten-Ping-Arbeit wie dort, nur für
   * GENAU das neue Mitglied statt der gesamten Liste.
   */
  async function addRoomMember(roomId, newFp) {
    const room = roomById(roomId);
    if (!room || room.members.includes(newFp) || newFp === qu.fingerprint) return;
    // src/modules/space-membership.js's addSpaceMember() — grants write/
    // admin access AND pings every member's inbox (including the new one,
    // see ensureRoom()s Doku); we only add the local rooms-list/contact/
    // avatar-subscription bookkeeping specific to this app on top.
    const updatedMembers = await qu.addSpaceMember(roomId, room.members, newFp, { alias: myAlias, name: room.name ?? null });
    upsertRoom(roomId, { members: updatedMembers });

    await repl.sync({ topic: `~${newFp}` }).catch((e) => console.error('[chat] peer profile sync failed:', newFp, e));
    if (!contactByFp(newFp)) {
      let alias = shortFp(newFp);
      try { alias = (await qu.readProfile(newFp)).alias ?? alias; } catch { /* aliasFor() holt es später live nach */ }
      upsertContact(newFp, { alias });
    }
    const unsubs = unsubsByRoom.get(roomId) ?? [];
    unsubs.push(qu.get(`~${newFp}`).get('avatar').on((q) => {
      const url = q?.value ?? null;
      avatarCache.set(newFp, url);
      upsertContact(newFp, { avatar: url });
      if (activeRoomId === roomId) renderRoomHeader(roomById(roomId));
      renderRoomList();
    }));
    unsubs.push(qu.get(`~${newFp}`).get('alias').on((q) => {
      if (contactByFp(newFp)?.aliasCustom) return;
      const name = q?.value ?? shortFp(newFp);
      aliasCache.set(newFp, name);
      upsertContact(newFp, { alias: name });
      if (activeRoomId === roomId) renderRoomHeader(roomById(roomId));
      renderRoomList();
    }));

    renderRoomList();
    if (activeRoomId === roomId) { renderRoomHeader(roomById(roomId)); renderPresence(roomId); }
  }

  /**
   * Entfernt `fp` aus einer Gruppe. Die eigentliche Wirkung: sendMessage()s
   * `encryptFor` (Composer) liest `room.members` bei JEDEM Senden neu — ein
   * entferntes Mitglied wird ab sofort nicht mehr adressiert, kann künftige
   * Nachrichten also nicht mehr entschlüsseln, selbst wenn es (über
   * `readers: ['*']`) weiterhin Chiffretext zu sehen bekäme. Schreibrecht
   * im Space-Manifest wird zusätzlich entzogen (kann also auch nicht mehr
   * SELBST schreiben). Bereits VOR der Entfernung gesendete Nachrichten
   * bleiben für sie entschlüsselbar — dieselbe "Vergangenheit ändert sich
   * nicht" wie bei deleteRoom() oben, kein rückwirkendes Neu-Verschlüsseln.
   */
  async function removeRoomMember(roomId, fp) {
    const room = roomById(roomId);
    if (!room || !room.members.includes(fp)) return;
    const updatedMembers = await qu.removeSpaceMember(roomId, room.members, fp);
    upsertRoom(roomId, { members: updatedMembers });
    renderRoomList();
    if (activeRoomId === roomId) { renderRoomHeader(roomById(roomId)); renderPresence(roomId); }
  }

  /** Reagiert auf einen eingehenden Briefkasten-Eintrag (siehe ensureRoom() oben) — legt den Raum (und ggf. den Absender als Kontakt) bei Bedarf lokal an, ganz ohne dass die Nutzerin ihn vorher selbst hinzugefügt haben muss. Funktioniert identisch für einen neuen DM UND eine neue/erweiterte Gruppe. */
  function handleInboxRequest(q) {
    const fromFp = q?.value?.fromFp;
    const roomId = q?.value?.id;
    if (!fromFp || fromFp === qu.fingerprint || !roomId) return;
    if (!contactByFp(fromFp)) upsertContact(fromFp, { alias: q.value.alias || shortFp(fromFp) });
    if (!roomById(roomId)) {
      const members = Array.isArray(q.value.members) && q.value.members.length ? q.value.members : [fromFp];
      upsertRoom(roomId, { name: q.value.name ?? null, members });
    }
    renderRoomList();
    ensureRoom(roomId).catch((e) => console.error('[chat] ensureRoom (inbox) failed:', roomId, e));
  }

  function handleIncomingMessage(roomId, q) {
    const seen = seenIdsByRoom.get(roomId);
    if (seen.has(q.id)) return;
    seen.add(q.id);
    const list = messagesByRoom.get(roomId);
    list.push(q);
    list.sort((a, b) => a.ts - b.ts);

    const room = roomById(roomId);
    const mine = q.writer === qu.fingerprint;
    const preview = q.value?.text || (q.refs?.length ? '📎 Anhang' : '');
    const unread = mine || activeRoomId === roomId ? 0 : (room?.unread ?? 0) + 1;
    upsertRoom(roomId, { lastTs: q.ts, lastPreview: preview, lastMine: mine, unread });
    renderRoomList();

    if (activeRoomId === roomId) {
      appendLiveMessage(q);
      if (document.hasFocus()) markActiveRead();
    }

    // Ton bewusst schon dann, wenn nur der GERADE OFFENE Chat ein anderer
    // ist (nicht erst ohne Fenster-Fokus wie die Desktop-Benachrichtigung
    // unten) — man soll eine neue Nachricht in einem anderen Chat auch
    // hören, während man aktiv in der App ist, genau wie bei Signal/Telegram.
    if (!mine && activeRoomId !== roomId && !isRoomMuted(roomId)) playMessageSound();

    // Lokale Benachrichtigung für "Tab läuft noch, ist aber nicht im
    // Fokus" (Handy gesperrt, anderer Tab aktiv, …) — der komplementäre
    // Fall zu echtem Web Push (sw.js/relay.mjs's push-Hook), das der
    // Relay bewusst NUR für getrennte Verbindungen auslöst (siehe dort);
    // beide Wege feuern also nie für dasselbe Ereignis gleichzeitig.
    if (!mine && !document.hasFocus() && !isRoomMuted(roomId) && Notification.permission === 'granted') {
      try {
        const senderName = contactByFp(q.writer)?.alias ?? shortFp(q.writer);
        const body = isGroupRoom(room) ? `${senderName} in ${roomDisplayName(room)}` : `${senderName} hat dir geschrieben`;
        const notif = new Notification('QU Chat', { body, tag: roomId });
        notif.addEventListener('click', () => { window.focus(); navigate(roomId); notif.close(); });
      } catch { /* z. B. Safari verweigert new Notification() aus einem Service-Worker-losen Kontext manchmal leise — kein harter Fehler */ }
    }
  }

  async function markActiveRead() {
    if (!activeRoomId) return;
    const list = messagesByRoom.get(activeRoomId) ?? [];
    const last = list.at(-1);
    if (!last) return;
    await qu.markRead(activeRoomId, last.ts);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markActiveRead(); });
  window.addEventListener('focus', () => markActiveRead());

  /**
   * "online" ist eine von der VERSTREICHENDEN ZEIT abgeleitete Größe
   * (modules/chat.js's getPresence(): frisch genug oder nicht), nicht nur
   * vom zuletzt empfangenen Ereignis — ein Mitglied, das die App
   * schließt, sendet schlicht NICHTS mehr, es gibt also kein weiteres
   * Ereignis, das onPresenceChange() erneut auslösen würde, damit die
   * Anzeige auf "offline" nachzieht. Statt das mit einem pauschalen Poll
   * zu übertünchen, plant diese Funktion sich selbst EIN einziges Mal neu:
   * solange mindestens ein Mitglied gerade online ist, genau EIN
   * setTimeout auf exakt den Moment, an dem das FRÜHESTE `lastSeen` das
   * Stale-Fenster verlässt — ein neueres Ereignis (onPresenceChange() ruft
   * renderPresence() erneut auf) ersetzt diesen Timer einfach, statt einen
   * zweiten parallel laufen zu lassen. Reines UI-Nachziehen einer bereits
   * reaktiv bekannten Zeitschranke, kein Ersatz für die eigentlichen
   * `.on()`/`.map()`-Abos. Bei einem DM (ein Mitglied) UND einer Gruppe
   * (mehrere) derselbe Code — nur die ANZEIGE unterscheidet sich (online/
   * offline vs. "N Mitglieder, M online").
   */
  function renderPresence(roomId) {
    clearTimeout(presenceStaleTimerByRoom.get(roomId));
    presenceStaleTimerByRoom.delete(roomId);
    const room = roomById(roomId);
    if (!room) return;
    qu.getPresence(roomId, { staleAfterMs: PRESENCE_STALE_MS }).then((presence) => {
      const group = isGroupRoom(room);
      const onlineCount = room.members.filter((fp) => presence[fp]?.online).length;
      const online = group ? onlineCount > 0 : !!presence[room.members[0]]?.online;
      if (activeRoomId === roomId) {
        if (group) {
          peerStatusEl.textContent = `${room.members.length + 1} Mitglieder${onlineCount ? `, ${onlineCount} online` : ''}`;
        } else {
          const info = presence[room.members[0]];
          peerStatusEl.textContent = online ? 'online' : (info?.lastSeen ? `zuletzt online ${fmtTime(info.lastSeen)}` : 'offline');
        }
        peerStatusEl.classList.toggle('online', online);
        // Der Punkt hängt IMMER direkt an #chat-peer-identity selbst (nicht
        // am Avatar) und wird per CSS auf dessen Ecke positioniert — bei
        // einem DM steckt der Avatar sonst im internen Markup von
        // <qu-profile-card>, das von hier aus nicht umgebaut werden soll
        // (style.css's .chat-peer-identity .dot-Doku).
        const dot = chatPeerIdentityEl.querySelector('.dot') ?? chatPeerIdentityEl.appendChild(el('span', 'dot'));
        dot.classList.toggle('online', online);
      }
      const listItem = contactListEl.querySelector(`[data-room="${roomId}"] .dot`);
      if (listItem) listItem.classList.toggle('online', online);

      const soonestDueInMs = room.members
        .map((fp) => presence[fp])
        .filter((info) => info?.online && info.lastSeen)
        .map((info) => info.lastSeen + PRESENCE_STALE_MS - Date.now())
        .reduce((min, v) => Math.min(min, v), Infinity);
      if (Number.isFinite(soonestDueInMs)) {
        presenceStaleTimerByRoom.set(roomId, setTimeout(() => renderPresence(roomId), Math.max(0, soonestDueInMs)));
      }
    }).catch(() => {});
  }

  function renderTicks(roomId) {
    const receipts = receiptsByRoom.get(roomId) ?? {};
    const pendingIds = new Set(pendingDeliveries.map((p) => p.id));
    for (const li of messageListEl.querySelectorAll('[data-mine="1"]')) {
      const id = li.dataset.id;
      const ts = Number(li.dataset.ts);
      const read = Object.entries(receipts).some(([reader, upTo]) => reader !== qu.fingerprint && upTo >= ts);
      const tick = li.querySelector('.tick');
      if (!tick) continue;
      // Reihenfolge: gelesen schlägt immer "noch nicht beim Relay
      // bestätigt" (ein Empfänger, der es gelesen hat, hat es zwangsläufig
      // auch empfangen — sonst könnte er es gar nicht gelesen haben,
      // selbst wenn UNSERE eigene waitUntilReplicated()-Prüfung noch
      // aussteht/fehlgeschlagen ist).
      if (read) { tick.textContent = '✓✓'; tick.classList.add('read'); tick.classList.remove('pending'); }
      else if (pendingIds.has(id) && !deliveredMsgIds.has(id)) { tick.textContent = '🕐'; tick.classList.remove('read'); tick.classList.add('pending'); }
      else { tick.textContent = '✓'; tick.classList.remove('read', 'pending'); }
    }
  }

  // --- Rendering: Chat-/Raumliste (1:1 UND Gruppen, kein Unterschied im Markup außer dem Avatar-Fallback) ---
  /**
   * Eine Gruppe hat keine EINZELNE Identität (ihr Name/Avatar sind
   * raumeigen, siehe roomDisplayName()/roomDisplayAvatar()) — dafür bleibt
   * der bisherige, manuell gebaute Avatar+Name. Ein DM dagegen IST genau
   * eine Identität (das eine andere Mitglied), dafür jetzt ein
   * <qu-profile-card> (src/ui/profile-components.js): reaktiv über
   * dessen globales Profil, mit Link auf das volle Profil in
   * examples/people — kein eigenes Alias-/Avatar-Live-Abo mehr nötig,
   * das übernimmt die Komponente komplett selbst.
   */
  function renderRoomHeader(room) {
    chatPeerIdentityEl.textContent = '';
    if (isGroupRoom(room)) {
      const name = roomDisplayName(room);
      const avatarEl = el('button', 'avatar');
      avatarEl.type = 'button';
      setAvatar(avatarEl, name, roomDisplayAvatar(room));
      chatPeerIdentityEl.append(avatarEl, el('div', 'chat-peer-name', name));
    } else {
      const card = document.createElement('qu-profile-card');
      card.setAttribute('fp', room.members[0]);
      card.setAttribute('href', '../people/index.html#/{fp}');
      card.qu = qu;
      chatPeerIdentityEl.appendChild(card);
    }
    // #chat-peer-identity wurde gerade komplett neu aufgebaut (textContent
    // = '' oben) — der Online-Punkt (renderPresence()s eigenes .dot-Kind
    // darin, siehe dessen Doku) ist also gerade verloren gegangen; sofort
    // neu anstoßen statt auf das nächste Presence-Ereignis/Heartbeat-Tick
    // zu warten, sonst fehlt er kurzzeitig nach jedem Header-Neubau (z. B.
    // ausgelöst durch eine entfernte Alias-/Avatar-Änderung).
    renderPresence(room.id);
  }

  function renderRoomList() {
    contactListEl.textContent = '';
    const withNames = rooms.map((r) => ({ ...r, alias: roomDisplayName(r) }));
    const sorted = sortByActivity(withNames);
    if (!sorted.length) {
      const empty = el('li', 'empty-list');
      empty.append('Noch keine Chats. ');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Jetzt starten';
      btn.addEventListener('click', () => navigate('add-contact'));
      empty.appendChild(btn);
      contactListEl.appendChild(empty);
      return;
    }
    for (const r of sorted) {
      const li = el('li', `contact${activeRoomId === r.id ? ' active' : ''}`);
      li.dataset.room = r.id;
      const avatar = el('div', 'avatar sm');
      setAvatar(avatar, r.alias, roomDisplayAvatar(r));
      avatar.appendChild(el('span', 'dot'));
      li.appendChild(avatar);
      // Nur bei einem DM lohnt sich ein Nachladeversuch (roomDisplayAvatar()
      // liest bei einer Gruppe schon `room.avatar` direkt, kein separater
      // Netzwerk-Abruf nötig) — avatarFor() ist eine Pro-IDENTITÄT-Sache.
      if (!isGroupRoom(r) && !roomDisplayAvatar(r)) {
        avatarFor(r.members[0]).then((url) => { if (url) setAvatar(avatar, r.alias, url); });
      }

      const body = el('div', 'contact-body');
      const top = el('div', 'contact-top');
      const nameEl = el('div', 'contact-name', r.alias);
      top.appendChild(nameEl);
      top.appendChild(el('div', 'contact-time', r.lastTs ? fmtTime(r.lastTs) : ''));
      body.appendChild(top);
      // Derselbe Nachladeweg wie für den Avatar direkt darüber — der Alias
      // ist beim allerersten Rendern (Kontakt gerade erst hinzugefügt, vor
      // dem ersten Öffnen des Chats) evtl. noch nicht aus dem Netzwerk
      // aufgelöst (isAliasUnresolved()); danach übernimmt ensureRoom()s
      // Live-Abo. Aktualisiert gezielt nur dieses Element statt eines
      // vollen renderRoomList()-Neurenderns (vermeidet Rekursion).
      if (!isGroupRoom(r) && isAliasUnresolved(r.members[0], r.alias)) {
        aliasFor(r.members[0]).then((name) => {
          if (name && !isAliasUnresolved(r.members[0], name)) { nameEl.textContent = name; setAvatar(avatar, name, roomDisplayAvatar(r)); }
        });
      }
      const previewRow = el('div', 'contact-preview');
      const previewText = r.lastTs ? `${r.lastMine ? 'Du: ' : ''}${r.lastPreview ?? ''}` : 'Noch keine Nachrichten';
      previewRow.appendChild(el('div', 'contact-last', previewText));
      if (r.unread) previewRow.appendChild(el('div', 'contact-unread', String(r.unread)));
      body.appendChild(previewRow);
      li.appendChild(body);

      li.addEventListener('click', () => navigate(r.id));
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
    const wrap = el('div', 'attachment');
    let status = el('div', 'attachment-progress', 'wird geladen …');
    wrap.appendChild(status);

    // name/mime/size stehen bei einem verschlüsselten Anhang NICHT direkt
    // im Manifest (siehe data/files/manifest.js's metaEncryption) — readFileMeta()
    // entschlüsselt sie separat vom eigentlichen Dateiinhalt, damit Vorschau/
    // Download-Link auch VOR dem vollständigen Herunterladen möglich sind.
    const fileMeta = await readFileMeta(manifest, qu.identity);
    if (!fileMeta) return el('div', 'attachment-progress', 'Anhang nicht zugänglich (nicht für dich verschlüsselt).');
    const kind = mediaKind(fileMeta.mime);

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

        const bytes = await reassembleFile(localFileStorage, manifest, qu.identity);
        if (!bytes) { showError('Anhang konnte nicht zusammengesetzt werden.'); return; }
        const blob = new Blob([bytes], { type: fileMeta.mime });
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
          a.download = fileMeta.name;
          a.appendChild(el('span', 'file-ic', kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📄'));
          const metaEl = el('div');
          metaEl.appendChild(el('div', '', fileMeta.name));
          metaEl.appendChild(el('div', 'file-meta', `${fileMeta.mime} · ${fmtBytes(fileMeta.size ?? bytes.length)}`));
          a.appendChild(metaEl);
          wrap.appendChild(a);
          stickToBottomIfNeeded();
        }

        if (kind === 'image') {
          const img = el('img', 'attachment-media');
          img.src = url;
          img.alt = fileMeta.name;
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
    li.dataset.id = q.id;
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

  async function renderMessageList(roomId) {
    messageListEl.textContent = '';
    lastRenderedDay = null;
    const list = messagesByRoom.get(roomId) ?? [];
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
    renderTicks(roomId);
  }

  /** Hängt EINE neu eingetroffene Live-Nachricht an, statt die komplette Liste neu aufzubauen (kein erneutes Laden/Rendern schon vorhandener Anhänge bei jeder neuen Nachricht) — folgt dem Ende nur, wenn man vorher schon dort war (isNearBottom()), reißt also niemanden aus der gerade gelesenen älteren Historie. */
  async function appendLiveMessage(q) {
    const stick = isNearBottom();
    const dayLabel = fmtDayLabel(q.ts);
    if (dayLabel !== lastRenderedDay) { messageListEl.appendChild(el('li', 'day-sep', dayLabel)); lastRenderedDay = dayLabel; }
    messageListEl.appendChild(await buildMessageItem(q));
    if (stick) messageListEl.scrollTop = messageListEl.scrollHeight;
    renderTicks(activeRoomId);
  }

  /** Öffnet einen bereits bekannten Raum (siehe rooms/ROOMS_KEY) — 1:1 UND Gruppe laufen durch denselben Code, nur roomDisplayName()/roomDisplayAvatar() unterscheiden zwischen beiden. */
  /** Chatliste — der Wurzel-Screen (`/`). hideAllScreens() (Router) hat bereits alles andere versteckt; hier nur, was DIESER Screen selbst braucht. */
  function showChatListScreen() {
    activeRoomId = null;
    emptyStateEl.classList.add('show');
  }

  /** Ein Chat — `/<roomId>` (Router). */
  async function showChatScreen(room) {
    const roomId = room.id;
    activeRoomId = roomId;
    renderRoomHeader(room);
    peerStatusEl.textContent = '…';
    appEl.classList.add('chat-open');
    chatPanelEl.classList.remove('hidden-empty');
    // Anrufe bleiben (vorerst) 1:1 — kein Gruppenanruf, siehe
    // audioCallBtn/videoCallBtn's eigene Doku weiter unten.
    audioCallBtn.hidden = isGroupRoom(room);
    videoCallBtn.hidden = isGroupRoom(room);

    // Erst NACH ensureRoom() (das jedes Mitglieds Userspace synct, siehe
    // dort) nach dem Avatar fragen — vorher lokal nachzusehen würde bei
    // einem gerade erst hinzugefügten Kontakt fast immer "keiner" liefern,
    // weil schlicht noch nichts synct war.
    await ensureRoom(roomId);
    if (!isGroupRoom(room) && !roomDisplayAvatar(room)) {
      avatarFor(room.members[0]).then((url) => {
        if (!url) return;
        if (activeRoomId === roomId) renderRoomHeader(room);
        renderRoomList();
      });
    }
    if (!isGroupRoom(room) && isAliasUnresolved(room.members[0], roomDisplayName(room))) {
      aliasFor(room.members[0]).then((name) => {
        if (!name || isAliasUnresolved(room.members[0], name)) return;
        if (activeRoomId === roomId) renderRoomHeader(roomById(roomId) ?? room);
        renderRoomList();
      });
    }
    renderPresence(roomId);
    upsertRoom(roomId, { unread: 0 });
    renderRoomList();
    await renderMessageList(roomId);
    await markActiveRead();
  }
  backBtn.addEventListener('click', closeScreen);
  chatSettingsBtn.addEventListener('click', () => { if (activeRoomId) navigate(activeRoomId, 'settings'); });

  // --- Suche (über alle Chats hinweg) ---
  // messagesByRoom hält bereits JEDEN Raum jedes Kontakts geladen
  // (ensureRoom() läuft beim Start für alle Kontakte, siehe main()s
  // Ende) — Suche ist also ein reiner In-Memory-Filter, keine eigene
  // Server-Anfrage nötig. Filtert nach Nachrichtentext UND/ODER (per
  // Filter-Chip) danach, ob eine Nachricht einen Link (chat-lib.mjs's
  // linkify()) bzw. einen Anhang (q.refs) enthält — eine reine
  // Dateiname-Suche innerhalb von Anhängen ist bewusst NICHT enthalten:
  // Name/MIME stehen erst im (asynchron nachzuladenden) Datei-Manifest,
  // nicht in der Nachricht selbst, das würde die Suche pro Tastendruck
  // in einen Netzwerk-Vorgang verwandeln statt eines simplen Array-Filters.
  let searchFilter = 'all'; // 'all' | 'links' | 'files'
  const SEARCH_RESULT_LIMIT = 100;

  function messageHasLink(q) {
    return !!q.value?.text && linkify(q.value.text).some((seg) => seg.type === 'link');
  }
  function messageHasFile(q) {
    return (q.refs?.length ?? 0) > 0;
  }
  function matchesSearch(q, query) {
    if (searchFilter === 'links' && !messageHasLink(q)) return false;
    if (searchFilter === 'files' && !messageHasFile(q)) return false;
    if (!query) return true;
    return (q.value?.text ?? '').toLowerCase().includes(query);
  }

  /** Baut das Snippet mit dem Treffer in der Mitte (statt immer ab Zeichen 0) und dem gesuchten Teil in `<mark>` — bei einer reinen Filter-Suche (Links/Dateien) ohne Textabfrage ist `query` leer, dann einfach der volle Text/Platzhalter. */
  function buildSnippet(text, query) {
    const snippet = el('div', 'search-result-snippet');
    const idx = query ? text.toLowerCase().indexOf(query) : -1;
    if (idx === -1) { snippet.textContent = text; return snippet; }
    const CONTEXT = 40;
    const start = Math.max(0, idx - CONTEXT);
    const end = Math.min(text.length, idx + query.length + CONTEXT);
    if (start > 0) snippet.appendChild(document.createTextNode('… '));
    snippet.appendChild(document.createTextNode(text.slice(start, idx)));
    snippet.appendChild(el('mark', undefined, text.slice(idx, idx + query.length)));
    snippet.appendChild(document.createTextNode(text.slice(idx + query.length, end)));
    if (end < text.length) snippet.appendChild(document.createTextNode(' …'));
    return snippet;
  }

  function renderSearchResults() {
    const rawQuery = searchInput.value.trim();
    const query = rawQuery.toLowerCase();
    searchClearBtn.hidden = !rawQuery;
    searchResultsEl.textContent = '';

    if (!query && searchFilter === 'all') {
      searchEmptyEl.hidden = false;
      searchEmptyEl.textContent = 'Suche nach Text, oder wähle „Links“/„Dateien“, um zu stöbern.';
      return;
    }

    const matches = [];
    for (const [roomId, list] of messagesByRoom) {
      for (const q of list) {
        if (matchesSearch(q, query)) matches.push({ roomId, q });
      }
    }
    matches.sort((a, b) => b.q.ts - a.q.ts);

    if (!matches.length) {
      searchEmptyEl.hidden = false;
      searchEmptyEl.textContent = 'Keine Treffer.';
      return;
    }
    searchEmptyEl.hidden = true;

    for (const { roomId, q } of matches.slice(0, SEARCH_RESULT_LIMIT)) {
      const room = roomById(roomId);
      // Bei einer Gruppe zusätzlich zum Raumnamen der tatsächliche
      // Absender — bei einem DM ist das ohnehin immer dieselbe Person wie
      // der Raum selbst, keine zusätzliche Zeile nötig.
      const name = roomDisplayName(room);
      const senderName = isGroupRoom(room) ? (contactByFp(q.writer)?.alias ?? shortFp(q.writer)) : name;
      const li = el('li', 'search-result');
      const avatar = el('div', 'avatar sm');
      setAvatar(avatar, name, roomDisplayAvatar(room));
      li.appendChild(avatar);
      const body = el('div', 'search-result-body');
      const top = el('div', 'search-result-top');
      top.appendChild(el('span', 'search-result-name', isGroupRoom(room) ? `${name} · ${senderName}` : name));
      top.appendChild(el('span', 'search-result-time', `${fmtDayLabel(q.ts)} · ${fmtTime(q.ts)}`));
      body.appendChild(top);
      const text = q.value?.text || (q.refs?.length ? '📎 Anhang' : '');
      body.appendChild(buildSnippet(text, query));
      li.appendChild(body);
      li.addEventListener('click', () => openSearchResult(roomId, q.id));
      searchResultsEl.appendChild(li);
    }
  }

  /**
   * `retry`: EIN erneuter Versuch nach kurzer Verzögerung, falls die
   * Nachricht noch nicht lokal geladen ist — relevant für einen frischen
   * Direktlink (`/<roomId>/msg/<id>`, siehe renderRoute()): der Chat wurde
   * gerade erst geöffnet, die Ziel-Nachricht kann (bei einem noch nicht
   * synchronisierten Gerät) einen Moment später ankommen als der Rest der
   * bereits bekannten Historie. Ein Klick auf ein Suchergebnis dagegen
   * trifft die Nachricht praktisch immer sofort (sie steht ja schon in
   * den durchsuchten, längst geladenen Daten) — der Retry schadet dort
   * nicht, greift nur nie.
   */
  function scrollToMessage(id, retry = true) {
    const li = messageListEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!li) {
      if (retry) setTimeout(() => scrollToMessage(id, false), 800);
      return;
    }
    li.scrollIntoView({ block: 'center' });
    const bubble = li.querySelector('.msg-bubble');
    // Klasse erst entfernen+reflow+wieder setzen, sonst startet die
    // CSS-Animation beim zweiten Sprung auf DIESELBE Nachricht nicht neu.
    bubble?.classList.remove('jump-highlight');
    void bubble?.offsetWidth;
    bubble?.classList.add('jump-highlight');
  }

  // Navigiert auf den teilbaren Direktlink dieser Nachricht (`/<roomId>/msg/<id>`,
  // siehe renderRoute()) statt nur intern zu scrollen — der Router selbst
  // übernimmt danach das eigentliche Öffnen+Springen, dieselbe Route wie
  // ein von außen eingefügter/geteilter Link.
  async function openSearchResult(roomId, messageId) {
    await navigate(roomId, 'msg', messageId);
  }

  /** Suche über alle Chats — `/search` (Router). */
  function showSearchScreen() {
    searchOverlay.hidden = false;
    searchInput.value = '';
    searchFilter = 'all';
    for (const btn of searchFiltersEl.querySelectorAll('.search-filter-btn')) btn.classList.toggle('active', btn.dataset.filter === 'all');
    renderSearchResults();
    searchInput.focus();
  }

  searchBtn.addEventListener('click', () => navigate('search'));
  searchBackBtn.addEventListener('click', closeScreen);
  searchInput.addEventListener('input', renderSearchResults);
  searchClearBtn.addEventListener('click', () => { searchInput.value = ''; renderSearchResults(); searchInput.focus(); });
  for (const btn of searchFiltersEl.querySelectorAll('.search-filter-btn')) {
    btn.addEventListener('click', () => {
      searchFilter = btn.dataset.filter;
      for (const b of searchFiltersEl.querySelectorAll('.search-filter-btn')) b.classList.toggle('active', b === btn);
      renderSearchResults();
    });
  }
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !searchOverlay.hidden) closeScreen(); });

  /**
   * Löscht einen Chat (1:1 ODER Gruppe) nur LOKAL — der Nachrichtenverlauf
   * bleibt für jedes andere Mitglied unangetastet (QU ist ein append-only
   * Log, Whitepaper §7; "löschen" heißt hier "wir hören auf
   * hinzuschauen", nicht "die Vergangenheit verschwindet für alle
   * Beteiligten"). Räumt alles auf, was ensureRoom() für diesen Raum
   * angelegt hat: laufende Live-Abos (unsubsByRoom), Presence-Heartbeat,
   * und den gesamten Pro-Raum-Zustand — ein erneutes Öffnen (z. B. über
   * einen Direktlink oder eine neue Nachricht in diesem Raum) ruft
   * ensureRoom() einfach wieder frisch auf. Rührt bewusst NICHT das
   * Adressbuch (contacts) an — ein Kontakt kann in anderen Chats
   * vorkommen, sein Alias/Avatar bleibt dort weiterhin gebraucht.
   */
  function deleteRoom(roomId) {
    stopHeartbeatByRoom.get(roomId)?.();
    stopHeartbeatByRoom.delete(roomId);
    for (const off of unsubsByRoom.get(roomId) ?? []) off();
    unsubsByRoom.delete(roomId);
    messagesByRoom.delete(roomId);
    seenIdsByRoom.delete(roomId);
    receiptsByRoom.delete(roomId);
    ensuredRooms.delete(roomId);
    clearTimeout(presenceStaleTimerByRoom.get(roomId));
    presenceStaleTimerByRoom.delete(roomId);
    removeRoomEntry(roomId);
    if (activeRoomId === roomId) navigate();
    renderRoomList();
  }

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
    if (!activeRoomId) return;
    const text = textInput.value.trim();
    const files = pendingFiles;
    if (!text && !files.length) return;
    const roomId = activeRoomId;
    const room = roomById(roomId);
    sendBtn.disabled = true;
    try {
      const attachments = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        attachments.push({ bytes, name: file.name, mime: file.type || 'application/octet-stream', fileStorage: localFileStorage });
      }
      // readers ist bewusst ['*'] (siehe ensureRoom()) — Vertraulichkeit
      // kommt hier ausschließlich aus dem expliziten encryptFor, nicht aus
      // einer restriktiven Space-ACL (die Default-Auto-Verschlüsselung in
      // core/session.js griffe nur bei eingeschränkten `readers`). `null`
      // statt der Empfängerliste, wenn diese Seite für DIESEN Chat
      // Verschlüsselung bewusst abgeschaltet hat (isRoomEncrypted() oben,
      // per mute-chat-btn-Pendant im Header) — session.js's eigene Doku
      // nennt genau das den vorgesehenen expliziten Opt-out. Alle
      // Mitglieder (nicht mehr nur EIN Peer) — bei einem DM ist das
      // exakt der bisherige Zwei-Empfänger-Fall, bei einer Gruppe sind
      // es entsprechend mehr.
      const sent = await qu.sendMessage(roomId, {
        text, attachments, encryptFor: isRoomEncrypted(roomId) ? [qu.fingerprint, ...room.members] : null,
        // Fortschritt für lokales Verschlüsseln/Zerstückeln GROSSER Anhänge
        // (z. B. ein Video) — ohne das sah ein größerer Upload nach einem
        // hängenden Sendevorgang aus, weil die UI vorher bis zum Schluss
        // nichts von der Arbeit zeigte, die publishFile() dabei im
        // Hintergrund macht (Hashing/Verschlüsseln pro Chunk).
        onAttachmentProgress: attachments.length ? (i, p) => {
          const label = attachments.length > 1 ? ` (${i + 1}/${attachments.length})` : '';
          statusBar.textContent = p.phase === 'encrypting'
            ? `Anhang wird verschlüsselt${label} …`
            : `Anhang wird hochgeladen${label} … ${Math.round((p.done / p.total) * 100)}%`;
        } : undefined,
      });
      statusBar.textContent = 'Verbunden';
      textInput.value = '';
      autoGrow();
      pendingFiles = [];
      renderPendingFiles();

      // "Beim Relay angekommen?"-Status: als unbestätigt eintragen (auch
      // persistiert, siehe PENDING_DELIVERY_KEY) und im Hintergrund prüfen
      // — siehe confirmDelivery()'s eigene Doku oben für das Wie/Warum.
      const entry = { id: sent.qubit.id, ts: sent.qubit.ts, roomId, refs: sent.refs };
      pendingDeliveries.push(entry);
      savePendingDeliveries(pendingDeliveries);
      if (activeRoomId === roomId) renderTicks(roomId);
      confirmDelivery(entry).catch(() => {});
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

  // --- Eigenes Profil — `/profile` (Router) ---
  let pendingAvatar; // undefined = unverändert, null = "entfernen", dataUrl = neu gewählt
  async function showProfileScreen() {
    $('alias-input').value = myAlias;
    $('my-fp-full').textContent = qu.fingerprint;
    pendingAvatar = undefined;
    setAvatar(avatarPreviewBtn, myAlias, myAvatar);
    // Aktuellen Sichtbarkeits-Stand direkt lesen (nicht aus qu.listDirectory()
    // — das liefert NUR sichtbare Einträge, hier muss aber auch der
    // "aktuell unsichtbar"-Fall unterscheidbar sein von "noch nie gesetzt").
    let ownEntry = null;
    try { ownEntry = await qu.get(`${DIRECTORY_ID}/entries/${qu.fingerprint}`); } catch { /* noch nie veröffentlicht */ }
    $('chat-directory-visible-toggle').checked = !!ownEntry?.value?.visible;
    profileModal.hidden = false;
  }
  meAvatarBtn.addEventListener('click', () => navigate('profile'));
  $('profile-cancel-btn').addEventListener('click', closeScreen);
  profileModal.addEventListener('click', (ev) => { if (ev.target === profileModal) closeScreen(); });
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
    await qu.setDirectoryVisible($('chat-directory-visible-toggle').checked);
    await repl.sync({ topic: qu.userSpaceId }).catch((e) => console.error('[chat] self-profile sync failed:', e));
    closeScreen();
  });
  $('copy-fp-btn').addEventListener('click', async () => {
    await navigator.clipboard.writeText(qu.fingerprint).catch(() => {});
  });
  $('share-link-btn').addEventListener('click', async () => {
    // Ein geteilter Einladungslink ist einfach `/add-contact/<fp>` — dieselbe
    // Route wie der "+"-Button, nur mit dem eigenen Fingerprint als zweitem
    // Pfadsegment vorausgefüllt (siehe Router-Doku oben und showAddContactScreen()).
    const link = location.origin + location.pathname + buildPath('add-contact', qu.fingerprint);
    if (navigator.share) { await navigator.share({ title: 'QU Chat', text: `Schreib mir im Chat: ${link}` }).catch(() => {}); }
    else { await navigator.clipboard.writeText(link).catch(() => {}); }
  });

  // --- App-Einstellungen — `/settings` (Router) ---
  function showAppSettingsScreen() {
    appSettingsModal.hidden = false;
    refreshPushUI();
    soundMessagesToggle.checked = soundEnabled(SOUND_MESSAGES_KEY);
    soundCallsToggle.checked = soundEnabled(SOUND_CALLS_KEY);
  }
  settingsBtn.addEventListener('click', () => navigate('settings'));
  $('app-settings-close-btn').addEventListener('click', closeScreen);
  appSettingsModal.addEventListener('click', (ev) => { if (ev.target === appSettingsModal) closeScreen(); });
  soundMessagesToggle.addEventListener('change', () => setSoundEnabled(SOUND_MESSAGES_KEY, soundMessagesToggle.checked));
  soundCallsToggle.addEventListener('change', () => setSoundEnabled(SOUND_CALLS_KEY, soundCallsToggle.checked));

  /**
   * "App zurücksetzen" — für den Fall, dass ein Update (Anruf-Code, ein
   * Bugfix) im Browser nicht ankommt: alten Service Worker loswerden
   * (`registration.update()` reicht bei einer bewusst NEUEN Version oft
   * nicht, ein Browser prüft Byte-Gleichheit erst mit Verzögerung),
   * CacheStorage leeren (heute ungenutzt von sw.js, defensiv trotzdem),
   * den lokalen Anhang-Cache (IndexedDB, s. IndexedDBFileStorageAdapter
   * oben) löschen — Dateien kommen bei Bedarf einfach erneut vom Relay —
   * und JEDES localStorage-Feld AUSSER dem Identitäts-Schlüssel selbst
   * (der private Schlüssel + Fingerprint sind das Einzige, dessen Verlust
   * nicht einfach neu geladen werden kann). Ein Reload mit
   * Cache-Busting-Query-Parameter erzwingt danach frische Netzwerk-Fetches
   * für app.mjs/chat-lib.mjs/style.css statt eines evtl. gecachten Standes.
   */
  $('reset-app-btn').addEventListener('click', async () => {
    if (!confirm('App zurücksetzen? Kontaktliste, Anzeigename und zwischengespeicherte Anhänge werden gelöscht. Dein Fingerprint (Identität) bleibt erhalten.')) return;
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('qu-chat-files');
        req.onsuccess = resolve; req.onerror = resolve; req.onblocked = resolve;
      });
      for (const key of Object.keys(localStorage)) {
        if (key !== IDENTITY_KEY) localStorage.removeItem(key);
      }
    } catch (e) {
      console.error('[chat] reset failed:', e);
    }
    location.href = `${location.pathname}?reset=${Date.now()}`;
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

  /** Beim Laden (nicht nur beim Klick auf den Button): ein bereits erteiltes Abo erneut ans Relay melden — dessen Zuordnung ist rein flüchtig (siehe publishPushSubscription()s Doku), ein Browser rotiert eine Subscription außerdem gelegentlich selbst. Registriert den Service Worker NICHT mehr selbst (siehe registerServiceWorker() oben, längst beim main()-Start gelaufen) — nur noch die Push-spezifischen Folgeschritte. */
  async function initPush() {
    if (!pushSupported) { refreshPushUI(); return; }
    if (!swRegistration) await registerServiceWorker();
    if (!swRegistration) { refreshPushUI(); return; }
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

  // --- Neuer 1:1-Chat — `/add-contact[/<fp>]` (Router; die zweite Form ist
  // auch das Ziel eines geteilten Einladungslinks, siehe share-link-btn) ---
  //
  // <qu-people-search mode="search"> (src/ui/people-search-components.js)
  // als BEQUEME ZUSATZ-Option neben dem weiterhin vorhandenen Fingerprint-
  // Textfeld — ein Klick auf ein Suchergebnis füllt nur `contactFpInput`,
  // ersetzt es nicht (jemanden per eingefügtem Fingerprint aus einem
  // Einladungslink/einer Nachricht hinzuzufügen bleibt genauso möglich wie
  // vorher, unabhängig davon, ob diese Identität überhaupt im — freiwillig
  // sichtbaren, siehe modules/profiles.js — Verzeichnis steht). Einmalig
  // erzeugt (nicht bei jedem Öffnen neu), damit ihr Verzeichnis-Live-Abo
  // nicht bei jedem Öffnen/Schließen neu aufgebaut wird.
  const addContactSearch = document.createElement('qu-people-search');
  addContactSearch.setAttribute('mode', 'search');
  addContactSearch.setAttribute('fields', 'alias,fingerprint');
  addContactSearch.setAttribute('placeholder', 'Alias oder Fingerprint …');
  addContactSearch.qu = qu;
  addContactSearch.addEventListener('qu-profile-open', (ev) => {
    contactFpInput.value = ev.detail.fingerprint;
    addContactError.textContent = '';
  });
  $('add-contact-search-slot').replaceWith(addContactSearch);

  function showAddContactScreen(prefillFp = '') {
    contactFpInput.value = prefillFp ?? '';
    contactAliasInput.value = '';
    addContactError.textContent = '';
    addContactModal.hidden = false;
    if (!prefillFp) contactFpInput.focus();
  }
  addContactBtn.addEventListener('click', () => navigate('add-contact'));
  $('add-contact-cancel-btn').addEventListener('click', closeScreen);
  addContactModal.addEventListener('click', (ev) => { if (ev.target === addContactModal) closeScreen(); });
  $('add-contact-save-btn').addEventListener('click', async () => {
    const fp = normalizeFingerprint(contactFpInput.value);
    if (!fp) { addContactError.textContent = 'Ungültiger Fingerprint (24 Hex-Zeichen erwartet).'; return; }
    if (fp === qu.fingerprint) { addContactError.textContent = 'Das ist dein eigener Fingerprint.'; return; }
    if (!contactByFp(fp)) {
      const customAlias = contactAliasInput.value.trim();
      let alias = customAlias;
      if (!alias) {
        // Erst syncen, DANN lesen — readProfile() liest nur den lokalen
        // Store (core/session.js's get()), der für einen soeben erst
        // eingetippten Fingerprint noch leer ist, ohne diesen expliziten
        // Sync (dasselbe Muster wie ensureRoom()s Mitglieder-Sync).
        await repl.sync({ topic: `~${fp}` }).catch((e) => console.error('[chat] peer profile sync failed:', fp, e));
        try { alias = (await qu.readProfile(fp)).alias ?? shortFp(fp); } catch { alias = shortFp(fp); }
      }
      // aliasCustom: ein explizit hier eingetippter Alias ist ein
      // bewusstes lokales Override (siehe ensureRoom()s Alias-Live-Abo) —
      // wird NIE durch einen entfernten Alias-Wert überschrieben.
      upsertContact(fp, { alias, aliasCustom: !!customAlias });
    }
    const roomId = await startDm(fp);
    // redirectTo() statt navigate(): das ausgefüllte Formular soll nicht
    // als eigener Schritt im Verlauf stehen bleiben — "zurück" aus dem neu
    // geöffneten Chat soll dahin führen, wo man VOR dem Öffnen dieses
    // Screens war, nicht zurück ins (bereits abgeschickte) Formular.
    await redirectTo(roomId);
  });

  // --- Neue Gruppe — `/new-group` (Router) ---
  let newGroupExtraFps = []; // per Fingerprint hinzugefügte Mitglieder, die (noch) kein gespeicherter Kontakt sind
  // Die Auswahl lebt als eigener State (nicht nur als DOM-Checkbox-Zustand)
  // — renderNewGroupMemberPicker() baut die Liste bei JEDEM "Fingerprint
  // hinzufügen" komplett neu auf (frische <input>-Elemente), ein bereits
  // angehaktes Kontakt-Kästchen würde dabei sonst stillschweigend wieder
  // verlieren, was man vorher ausgewählt hatte.
  let newGroupSelectedFps = new Set();

  function renderNewGroupMemberPicker() {
    newGroupContactListEl.textContent = '';
    const candidates = [
      ...contacts.map((c) => ({ fp: c.fp, label: c.alias })),
      ...newGroupExtraFps.filter((fp) => !contactByFp(fp)).map((fp) => ({ fp, label: shortFp(fp) })),
    ];
    if (!candidates.length) {
      newGroupContactListEl.appendChild(el('li', 'empty-hint', 'Noch keine Kontakte — per Fingerprint unten hinzufügen.'));
      return;
    }
    for (const { fp, label } of candidates) {
      const li = el('li');
      const labelEl = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = fp;
      checkbox.checked = newGroupSelectedFps.has(fp);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) newGroupSelectedFps.add(fp); else newGroupSelectedFps.delete(fp);
      });
      labelEl.appendChild(checkbox);
      labelEl.append(label);
      li.appendChild(labelEl);
      newGroupContactListEl.appendChild(li);
    }
  }

  function showNewGroupScreen() {
    newGroupNameInput.value = '';
    newGroupFpInput.value = '';
    newGroupError.textContent = '';
    newGroupExtraFps = [];
    newGroupSelectedFps = new Set();
    renderNewGroupMemberPicker();
    newGroupModal.hidden = false;
    newGroupNameInput.focus();
  }
  newGroupBtn.addEventListener('click', () => navigate('new-group'));
  $('new-group-cancel-btn').addEventListener('click', closeScreen);
  newGroupModal.addEventListener('click', (ev) => { if (ev.target === newGroupModal) closeScreen(); });
  $('new-group-fp-add-btn').addEventListener('click', () => {
    const fp = normalizeFingerprint(newGroupFpInput.value);
    if (!fp) { newGroupError.textContent = 'Ungültiger Fingerprint (24 Hex-Zeichen erwartet).'; return; }
    if (fp === qu.fingerprint) { newGroupError.textContent = 'Das ist dein eigener Fingerprint.'; return; }
    newGroupFpInput.value = '';
    newGroupError.textContent = '';
    if (!contactByFp(fp) && !newGroupExtraFps.includes(fp)) newGroupExtraFps.push(fp);
    newGroupSelectedFps.add(fp); // frisch hinzugefügt heißt schon ausgewählt — kein zusätzlicher Klick nötig
    renderNewGroupMemberPicker();
  });
  $('new-group-save-btn').addEventListener('click', async () => {
    const name = newGroupNameInput.value.trim();
    if (!name) { newGroupError.textContent = 'Bitte einen Gruppennamen eingeben.'; return; }
    const selected = [...newGroupSelectedFps];
    if (!selected.length) { newGroupError.textContent = 'Bitte mindestens ein Mitglied auswählen.'; return; }
    for (const fp of selected) {
      if (!contactByFp(fp)) upsertContact(fp, { alias: shortFp(fp) });
    }
    const roomId = await createGroupRoom(name, selected);
    await redirectTo(roomId); // siehe add-contact-save-btn's Doku oben — kein Verlaufseintrag fürs abgeschickte Formular
  });

  // --- Chat-Einstellungen — `/<roomId>/settings` (Router). Stumm/
  // Verschlüsselung/Löschen für JEDEN Chat, Umbenennen/Mitglieder nur für
  // eine Gruppe (chatSettingsGroupSection wird für einen DM versteckt). ---
  function renderChatEncryptionHint(roomId) {
    chatEncryptionHint.textContent = isRoomEncrypted(roomId)
      ? 'Deine künftigen Nachrichten sind Ende-zu-Ende verschlüsselt — lesbar nur für die Mitglieder dieses Chats, nicht für den Relay-Betreiber.'
      : 'Deine künftigen Nachrichten werden im Klartext übertragen und gespeichert — lesbar für den Relay-Betreiber und für jeden mit Lesezugriff auf diesen Raum. Bereits gesendete Nachrichten bleiben unverändert. Gilt nur für DEINE Seite.';
  }

  function renderGroupMemberList(roomId) {
    groupMemberListEl.textContent = '';
    const room = roomById(roomId);
    for (const fp of room?.members ?? []) {
      const li = el('li');
      // <qu-profile-card> (src/ui/profile-components.js) statt manuell
      // gebautem Avatar+Name — reaktiv über das globale Profil dieses
      // Mitglieds (Alias-/Avatar-Änderungen kommen live an, ganz ohne ein
      // eigenes .on()-Abo hier), mit Link auf das volle Profil in
      // examples/people. Kein Konflikt mit dem ×-Button daneben — das <li>
      // selbst hatte nie einen eigenen Klick-Handler.
      const card = document.createElement('qu-profile-card');
      card.setAttribute('fp', fp);
      card.setAttribute('href', '../people/index.html#/{fp}');
      card.qu = qu;
      li.appendChild(card);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'member-remove-btn';
      removeBtn.title = 'Aus der Gruppe entfernen';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async () => {
        await removeRoomMember(roomId, fp);
        renderGroupMemberList(roomId);
      });
      li.appendChild(removeBtn);
      groupMemberListEl.appendChild(li);
    }
    if (!room?.members?.length) groupMemberListEl.appendChild(el('li', 'empty-hint', 'Keine weiteren Mitglieder.'));
  }

  function showChatSettingsScreen(room) {
    const roomId = room.id;
    activeRoomId = roomId; // Einstellungen gehören zu GENAU diesem Raum — bleibt "aktiv" wie im Chat-Screen selbst, siehe renderPresence()/renderTicks() u. a., die harmlos auf jetzt verstecktes Markup zielen, falls der darunterliegende Chat-Screen selbst gerade nicht sichtbar ist.
    chatSettingsTitleEl.textContent = roomDisplayName(room);
    chatSettingsGroupSection.hidden = !isGroupRoom(room);
    if (isGroupRoom(room)) {
      groupNameInput.value = room.name ?? '';
      groupAddMemberInput.value = '';
      groupDetailsError.textContent = '';
      renderGroupMemberList(roomId);
    }
    chatMuteToggle.checked = isRoomMuted(roomId);
    chatEncryptionToggle.checked = isRoomEncrypted(roomId);
    renderChatEncryptionHint(roomId);
    chatSettingsModal.hidden = false;
  }
  $('chat-settings-close-btn').addEventListener('click', closeScreen);
  chatSettingsModal.addEventListener('click', (ev) => { if (ev.target === chatSettingsModal) closeScreen(); });
  chatMuteToggle.addEventListener('change', () => {
    if (!activeRoomId) return;
    setRoomMuted(activeRoomId, chatMuteToggle.checked);
  });
  chatEncryptionToggle.addEventListener('change', () => {
    if (!activeRoomId) return;
    const roomId = activeRoomId;
    // Nur beim AUSSCHALTEN warnen — wieder EINschalten ist immer die
    // sichere Richtung, braucht keine Bestätigung.
    if (!chatEncryptionToggle.checked) {
      const name = roomDisplayName(roomById(roomId));
      const confirmed = confirm(
        `Verschlüsselung für den Chat "${name}" deaktivieren?\n\n` +
        'Deine künftigen Nachrichten in diesem Chat werden dann im Klartext übertragen und gespeichert — lesbar für den Relay-Betreiber und für jeden mit Lesezugriff auf diesen Raum, nicht mehr nur für die Mitglieder. ' +
        'Bereits gesendete Nachrichten bleiben unverändert (weiterhin verschlüsselt). Das gilt nur für DEINE Seite — jedes andere Mitglied entscheidet unabhängig für seine eigenen Nachrichten.',
      );
      if (!confirmed) { chatEncryptionToggle.checked = true; return; }
    }
    setRoomEncrypted(roomId, chatEncryptionToggle.checked);
    renderChatEncryptionHint(roomId);
  });
  chatDeleteBtn.addEventListener('click', () => {
    if (!activeRoomId) return;
    const name = roomDisplayName(roomById(activeRoomId));
    if (!confirm(`Chat "${name}" löschen?\n\nDer Nachrichtenverlauf bleibt bei den anderen Mitgliedern erhalten, wird hier aber entfernt.`)) return;
    deleteRoom(activeRoomId);
  });
  $('group-rename-save-btn').addEventListener('click', async () => {
    if (!activeRoomId) return;
    const name = groupNameInput.value.trim();
    if (!name) { groupDetailsError.textContent = 'Bitte einen Gruppennamen eingeben.'; return; }
    groupDetailsError.textContent = '';
    await renameGroupRoom(activeRoomId, name).catch((e) => { groupDetailsError.textContent = `Fehler: ${e.message}`; });
    chatSettingsTitleEl.textContent = roomDisplayName(roomById(activeRoomId));
  });
  $('group-add-member-btn').addEventListener('click', async () => {
    if (!activeRoomId) return;
    const fp = normalizeFingerprint(groupAddMemberInput.value);
    if (!fp) { groupDetailsError.textContent = 'Ungültiger Fingerprint (24 Hex-Zeichen erwartet).'; return; }
    if (fp === qu.fingerprint) { groupDetailsError.textContent = 'Das ist dein eigener Fingerprint.'; return; }
    const room = roomById(activeRoomId);
    if (room.members.includes(fp)) { groupDetailsError.textContent = 'Ist bereits Mitglied.'; return; }
    groupDetailsError.textContent = '';
    groupAddMemberInput.value = '';
    await addRoomMember(activeRoomId, fp).catch((e) => { groupDetailsError.textContent = `Fehler: ${e.message}`; });
    renderGroupMemberList(activeRoomId);
  });

  // Erste Route rendern. Zeigt der aktuelle Hash NICHT die Chatliste
  // (Direktlink — ein geteilter Einladungslink, ein Lesezeichen, ein
  // Reload mitten in einem Screen), wird die aktuelle Adresse zuerst per
  // replaceState() zur Chatliste normalisiert und der eigentliche
  // Ziel-Hash DANACH per navigate() (echter Verlaufseintrag) obendrauf
  // gelegt — garantiert, dass history.back() (closeScreen()) aus JEDEM
  // Screen, auch einem direkt verlinkten, auf der Chatliste landet statt
  // die App zu verlassen (siehe Router-Doku weiter oben).
  if (location.hash && location.hash !== '#/') {
    const target = parsePathSegments(location.hash);
    history.replaceState(null, '', location.pathname);
    if (target.length) await navigate(...target);
  } else {
    await renderRoute();
  }

  // --- Anruf (Audio/Video über WebRTC) ---
  //
  // Baut auf dem bereits im Framework vorhandenen WebRTC-Unterbau auf
  // (src/network/webrtc-*.js) statt ihn neu zu erfinden: Perfect
  // Negotiation, die Signalisierung über den Relay (core/routed-events.js's
  // geroutete ephemere Events — "ein Anruf-Invite" ist dort wörtlich als
  // Beispiel genannt) und die erneute QU-Handshake-Verifikation NACH dem
  // WebRTC-Verbindungsaufbau (DTLS beweist nur Verschlüsselung, nicht WER
  // am anderen Ende ist) sind dort schon fertig. Neu ist hier nur: echte
  // Medien-Tracks auf GENAU dieselbe RTCPeerConnection legen, die
  // createWebRTCChannel() für den QU-Datenkanal sowieso schon aufbaut
  // (deren `peerConnection`-Getter ist laut eigenem Kommentar dort exakt
  // für diese spätere A/V-Erweiterung gedacht) — das eingebaute
  // `onnegotiationneeded` übernimmt die Neuverhandlung dafür automatisch,
  // ganz ohne Zusatzcode. Plus die Anruf-eigene Oberfläche/State-Machine.
  // (Zustandsvariablen selbst stehen bereits weiter oben, VOR dem ersten
  // connectToRelay()-Aufruf — setupCallSignaling() weist ihnen dort schon
  // zu, `let`/`const` sind bis zur eigenen Deklaration im "temporal dead
  // zone", ein Zugriff davor wirft, anders als bei gehoisteten
  // function-Deklarationen wie dieser hier.)

  // `{ facingMode: { ideal: 'user' } }`, NICHT der nackte Wert
  // `{ facingMode: 'user' }` — ein nackter Constraint-Wert zählt laut
  // Spec zur "basic constraint set" und muss GENAU erfüllt sein (wie
  // `{ exact: 'user' }`); manche echten Kameras/Browser melden ihre
  // Front-Kamera nicht exakt so, wie es dieser strikte Match erwartet,
  // und getUserMedia() wirft dann OverconstrainedError — mit `ideal`
  // wird daraus nur eine Präferenz, die der Browser bestmöglich erfüllt
  // statt komplett abzulehnen. Erklärt genau das gemeldete Bild "Audio
  // geht immer, Video stirbt beim Annehmen": nur der Video-Zweig fragt
  // überhaupt nach facingMode, ein Audio-Anruf umgeht dieses Constraint
  // komplett.
  async function getLocalStream(kind) {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: kind === 'video' ? { facingMode: { ideal: 'user' } } : false });
  }

  /** Klartext statt eines rohen DOMException-Namens — unterscheidet die drei häufigsten getUserMedia()-Fehlschlagsgründe, damit z. B. "Kamera kann diese Anforderung nicht erfüllen" nicht wie "Zugriff verweigert" aussieht (zwei völlig verschiedene Ursachen, ganz unterschiedliche nächste Schritte für die Nutzerin). */
  function mediaErrorMessage(e) {
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') return 'Zugriff auf Mikrofon/Kamera verweigert.';
    if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') return 'Keine passende Kamera/kein Mikrofon gefunden.';
    if (e.name === 'OverconstrainedError' || e.name === 'ConstraintNotSatisfiedError') return `Kamera/Mikrofon erfüllt eine Anforderung nicht (${e.constraint ?? e.name}).`;
    if (e.name === 'NotReadableError' || e.name === 'TrackStartError') return 'Kamera/Mikrofon wird bereits von einer anderen App verwendet.';
    return `Mikrofon/Kamera-Fehler: ${e.message || e.name}`;
  }
  function stopStream(stream) { stream?.getTracks().forEach((t) => t.stop()); }

  function renderCallUI() {
    if (!activeCall) { callOverlay.hidden = true; return; }
    callOverlay.hidden = false;
    const contact = contactByFp(activeCall.peerFp);
    const name = contact?.alias ?? activeCall.callerAlias ?? shortFp(activeCall.peerFp);
    callPeerNameEl.textContent = name;
    setAvatar(callAvatarEl, name, contact?.avatar);

    callIncomingActions.hidden = !(activeCall.state === 'ringing' && activeCall.direction === 'incoming');
    callOutgoingActions.hidden = !(activeCall.state === 'ringing' && activeCall.direction === 'outgoing');
    callConnectedActions.hidden = activeCall.state === 'ringing';
    callCameraBtn.hidden = activeCall.kind !== 'video';

    if (activeCall.state === 'ringing') {
      callStatusEl.textContent = activeCall.direction === 'incoming'
        ? `Eingehender ${activeCall.kind === 'video' ? 'Videoanruf' : 'Anruf'} …`
        : 'Ruft an …';
      callStatusEl.classList.remove('connected');
    } else if (activeCall.state === 'connecting') {
      callStatusEl.textContent = 'Verbinde …';
      callStatusEl.classList.remove('connected');
    } else {
      callStatusEl.textContent = fmtCallDuration((Date.now() - activeCall.startedAt) / 1000);
      callStatusEl.classList.add('connected');
    }

    callVideoArea.hidden = !(activeCall.kind === 'video' && activeCall.state !== 'ringing');
  }

  function startCallTimer() {
    stopCallTimer();
    activeCall.timerInterval = setInterval(() => { if (activeCall?.state === 'connected') renderCallUI(); }, 1000);
  }
  function stopCallTimer() { if (activeCall?.timerInterval) clearInterval(activeCall.timerInterval); }

  /** Beendet den aktuell aktiven Anruf (egal in welchem Zustand) und räumt alles auf — `notifyPeer: false` nur, wenn die Gegenseite selbst schon aufgelegt/abgelehnt hat (sonst bekäme sie ihr eigenes Hangup-Event zurückgespiegelt). */
  function endCall(reason, { notifyPeer = true } = {}) {
    if (!activeCall) return;
    console.log('[chat] call ended:', reason);
    stopRingtone();
    if (activeCall.ringTimeout) clearTimeout(activeCall.ringTimeout);
    stopCallTimer();
    if (notifyPeer) sendRoutedEvent(channel, activeCall.peerFp, 'call-hangup', {}).catch(() => {});
    pendingCallDecisions.delete(activeCall.peerFp);
    stopStream(activeCall.localStream);
    activeCall.channel?.close().catch(() => {});
    callRemoteVideo.srcObject = null;
    callLocalVideo.srcObject = null;
    activeCall = null;
    renderCallUI();
  }

  /** Feuert für JEDE erfolgreich aufgebaute WebRTC-Direktverbindung (eingehend wie ausgehend, PeerConnectionManager.onConnect()) — hier wird aus "Datenkanal steht" ein echter Anruf: eigene Tracks drauflegen, auf die der Gegenseite warten. */
  function onCallConnected(peerFp, rtcChannel) {
    if (!activeCall || activeCall.peerFp !== peerFp) return;
    activeCall.channel = rtcChannel;
    const pc = rtcChannel.peerConnection;
    activeCall.pc = pc;
    activeCall.state = 'connecting'; // muss VOR der ersten connectionstatechange-Prüfung unten stehen — siehe deren Kommentar
    stopRingtone();
    if (activeCall.ringTimeout) { clearTimeout(activeCall.ringTimeout); activeCall.ringTimeout = null; }

    for (const track of activeCall.localStream.getTracks()) pc.addTrack(track, activeCall.localStream);

    pc.addEventListener('track', (ev) => {
      if (!activeCall || activeCall.pc !== pc) return;
      activeCall.remoteStream = ev.streams[0];
      callRemoteVideo.srcObject = activeCall.remoteStream;
    });
    const onConnectionStateChange = () => {
      if (!activeCall || activeCall.pc !== pc) return;
      if (pc.connectionState === 'connected' && activeCall.state !== 'connected') {
        activeCall.state = 'connected';
        activeCall.startedAt = Date.now();
        startCallTimer();
        renderCallUI();
      } else if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && activeCall.state !== 'ended') {
        // "disconnected" kann sich bei WebRTC von selbst wieder erholen
        // (kurzer Netzwerk-Hänger) — nur "failed"/"closed" hier wirklich
        // als Gesprächsende behandeln, sonst legt eine kurze Funklücke
        // sofort und unnötig auf.
        if (pc.connectionState === 'disconnected') return;
        if (pc.connectionState === 'failed') statusBar.textContent = CALL_CONNECT_FAILED_MSG;
        endCall(`connection-${pc.connectionState}`, { notifyPeer: pc.connectionState === 'failed' });
      }
    };
    pc.addEventListener('connectionstatechange', onConnectionStateChange);
    // pc erreicht "connected" schon während der ERSTEN Aushandlung (nur
    // Datenkanal, für den QU-Handshake) — der hiesige Listener wird erst
    // NACH dem Handshake registriert (onCallConnected() läuft erst, wenn
    // der PeerConnectionManager die Verbindung als aufgebaut meldet), kann
    // den bereits vergangenen Übergang also verpassen. Einmal den
    // aktuellen Stand direkt nachholen, statt nur auf künftige Events zu warten.
    onConnectionStateChange();
    rtcChannel.onClose(() => { if (activeCall?.peerFp === peerFp) endCall('peer-closed', { notifyPeer: false }); });

    callLocalVideo.srcObject = activeCall.localStream;
    renderCallUI();
  }

  async function startCall(peerFp, kind) {
    if (activeCall) return; // schon in einem Gespräch — kein Anklopfen in diesem einfachen Ausbau
    if (!webrtcManager) { statusBar.textContent = 'Nicht verbunden — Anruf gerade nicht möglich.'; return; }
    activeCall = { peerFp, kind, direction: 'outgoing', state: 'ringing', callerAlias: myAlias, localStream: null, remoteStream: null, pc: null, channel: null, startedAt: null, timerInterval: null, ringTimeout: null };
    renderCallUI();
    startRingtone(); // Ruf-Ton für die ANRUFENDE Seite — hier keine Stumm-Prüfung, man ruft ja selbst an
    activeCall.ringTimeout = setTimeout(() => { if (activeCall?.state === 'ringing') endCall('timeout'); }, RING_TIMEOUT_MS);
    sendRoutedEvent(channel, peerFp, 'call-invite', { callType: kind, callerAlias: myAlias }).catch(() => {});
    let stream;
    try {
      stream = await getLocalStream(kind);
    } catch (e) {
      console.error('[chat] getUserMedia failed:', e.name, e.message);
      statusBar.textContent = mediaErrorMessage(e);
      endCall('media-denied');
      return;
    }
    if (!activeCall) { stopStream(stream); return; } // währenddessen schon wieder aufgelegt
    activeCall.localStream = stream;
    callLocalVideo.srcObject = stream;

    // Klingel-Ping (call-invite) UND das eigentliche WebRTC-Angebot sind
    // beides einmalige, ungepufferte Nachrichten (core/routed-events.js) —
    // ist die Gegenseite gerade nicht verbunden, verwirft der Relay sie
    // stillschweigend (relay.mjs's `route-target-offline`), es gibt KEINE
    // Warteschlange. relay.mjs weckt eine offline Gegenseite in diesem
    // Fall zwar per Web Push, aber ohne diese Schleife bliebe der EINE
    // schon verworfene Verbindungsversuch trotzdem für immer verloren —
    // die Gegenseite müsste selbst zurückrufen. Solange noch geklingelt
    // wird (RING_TIMEOUT_MS begrenzt das Ganze ohnehin), also alle
    // CALL_RETRY_INTERVAL_MS erneut anklingeln UND einen frischen
    // connectDirect()-Versuch anstoßen — channel.connect() hat selbst kein
    // Timeout (wartet sonst bis RING_TIMEOUT_MS unbegrenzt auf eine nie
    // kommende Antwort), deshalb hier bewusst NICHT abgewartet, sondern
    // nur beobachtet: ein WIRKLICHER Fehler (Handshake-Mismatch o. Ä., kein
    // simples "niemand antwortet") beendet den Anruf sofort, ein
    // schlicht (noch) unbeantworteter Versuch lässt einfach die nächste
    // Runde starten. Ein spät/parallel doch noch erfolgreicher älterer
    // Versuch ist unschädlich — onCallConnected() (siehe dort) prüft vor
    // jeder Wirkung, ob `activeCall`/dessen `pc` noch der AKTUELLE ist.
    const CALL_RETRY_INTERVAL_MS = 6000;
    while (activeCall?.peerFp === peerFp && activeCall.state === 'ringing') {
      webrtcManager.connectDirect(peerFp, { pushTopics: [] }).catch((e) => {
        if (activeCall?.peerFp === peerFp && activeCall.state === 'ringing') {
          console.error('[chat] call failed:', e);
          statusBar.textContent = CALL_CONNECT_FAILED_MSG;
          endCall('error');
        }
      });
      // onCallConnected() (über onConnect() unten) übernimmt den Rest, sobald irgendein Versuch wirklich steht.
      await wait(CALL_RETRY_INTERVAL_MS);
      if (activeCall?.peerFp === peerFp && activeCall.state === 'ringing') {
        sendRoutedEvent(channel, peerFp, 'call-invite', { callType: kind, callerAlias: myAlias }).catch(() => {});
      }
    }
  }

  // Anrufe bleiben (vorerst) 1:1 — ein Gruppenanruf bräuchte eine
  // Mehrparteien-WebRTC-Signalisierung, die dieser Umbau nicht anfasst;
  // die Buttons selbst sind für eine Gruppe schon ausgeblendet (siehe
  // showChatScreen()), dieser Guard ist nur die zweite, vom Markup
  // unabhängige Absicherung.
  audioCallBtn.addEventListener('click', () => {
    const room = roomById(activeRoomId);
    if (room && !isGroupRoom(room)) startCall(room.members[0], 'audio');
  });
  videoCallBtn.addEventListener('click', () => {
    const room = roomById(activeRoomId);
    if (room && !isGroupRoom(room)) startCall(room.members[0], 'video');
  });

  callAcceptBtn.addEventListener('click', async () => {
    if (!activeCall || activeCall.direction !== 'incoming') return;
    const peerFp = activeCall.peerFp;
    try {
      const stream = await getLocalStream(activeCall.kind);
      if (!activeCall || activeCall.peerFp !== peerFp) { stopStream(stream); return; } // z. B. während der Berechtigungsabfrage selbst abgelehnt/aufgelegt
      activeCall.localStream = stream;
      callLocalVideo.srcObject = stream;
      activeCall.state = 'connecting';
      stopRingtone();
      renderCallUI();
      pendingCallDecisions.get(peerFp)?.({ pushTopics: [] });
      pendingCallDecisions.delete(peerFp);
    } catch (e) {
      console.error('[chat] accepting call failed:', e.name, e.message);
      pendingCallDecisions.get(peerFp)?.(null);
      pendingCallDecisions.delete(peerFp);
      sendRoutedEvent(channel, peerFp, 'call-decline', { reason: 'media-denied' }).catch(() => {});
      statusBar.textContent = mediaErrorMessage(e);
      endCall('media-denied', { notifyPeer: false });
    }
  });

  callDeclineBtn.addEventListener('click', () => {
    if (!activeCall) return;
    pendingCallDecisions.get(activeCall.peerFp)?.(null);
    pendingCallDecisions.delete(activeCall.peerFp);
    sendRoutedEvent(channel, activeCall.peerFp, 'call-decline', {}).catch(() => {});
    endCall('declined', { notifyPeer: false });
  });

  callCancelBtn.addEventListener('click', () => { endCall('local-cancel'); });
  callHangupBtn.addEventListener('click', () => { endCall('local-hangup'); });

  callMuteBtn.addEventListener('click', () => {
    const track = activeCall?.localStream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callMuteBtn.classList.toggle('off', !track.enabled);
    callMuteBtn.textContent = track.enabled ? '🎤' : '🔇';
  });
  callCameraBtn.addEventListener('click', () => {
    const track = activeCall?.localStream?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    callCameraBtn.classList.toggle('off', !track.enabled);
    callCameraBtn.textContent = track.enabled ? '📷' : '🚫';
  });

  /**
   * An JEDEN (neuen) Relay-Channel neu gebunden — siehe connectToRelay(),
   * ganz analog zu den anderen `on...`-Abos dort: eine neue Channel-
   * Instanz kennt keine vorherigen Listener. Ein bereits laufendes
   * Gespräch übersteht das unangetastet (dessen RTCPeerConnection/
   * WebRTC-Channel hängt nicht am Relay-Channel, siehe onCallConnected()
   * oben), nur NEUE eingehende Signale brauchen den frischen Manager.
   */
  function setupCallSignaling(currentChannel) {
    webrtcManager = qu.webrtc(currentChannel, {
      onIncomingConnection: (fromFp) => new Promise((resolve) => pendingCallDecisions.set(fromFp, resolve)),
      iceServers,
    });
    webrtcManager.onConnect((peerFp, entry) => onCallConnected(peerFp, entry.channel));
    webrtcManager.onConnectFailed((peerFp) => {
      if (activeCall?.peerFp !== peerFp) return;
      statusBar.textContent = CALL_CONNECT_FAILED_MSG;
      endCall('error', { notifyPeer: false });
    });

    onRoutedEvent(currentChannel, 'call-invite', (msg) => {
      // startCall() klingelt bei einer (noch) nicht erreichbaren Gegenseite
      // periodisch erneut an (siehe dortige Doku) — eine wiederholte
      // Einladung VOM SELBEN Anrufer, während wir SEINETWEGEN schon
      // klingeln, ist genau das, kein zweiter Anruf: einfach ignorieren,
      // statt fälschlich mit "besetzt" zu antworten (das würde den
      // eigentlich noch laufenden Anruf sofort abwürgen).
      if (activeCall) {
        if (activeCall.peerFp === msg.from && activeCall.direction === 'incoming' && activeCall.state === 'ringing') return;
        sendRoutedEvent(currentChannel, msg.from, 'call-decline', { reason: 'busy' }).catch(() => {});
        return;
      }
      const fromFp = msg.from;
      const alias = contactByFp(fromFp)?.alias ?? msg.payload?.callerAlias ?? shortFp(fromFp);
      activeCall = {
        peerFp: fromFp, kind: msg.payload?.callType === 'video' ? 'video' : 'audio', direction: 'incoming', state: 'ringing',
        callerAlias: alias, localStream: null, remoteStream: null, pc: null, channel: null, startedAt: null, timerInterval: null,
        ringTimeout: setTimeout(() => {
          if (activeCall?.peerFp === fromFp && activeCall.state === 'ringing') {
            pendingCallDecisions.get(fromFp)?.(null);
            pendingCallDecisions.delete(fromFp);
            endCall('timeout', { notifyPeer: false });
          }
        }, RING_TIMEOUT_MS),
      };
      renderCallUI();
      // Calls bleiben bewusst 1:1 (peerFp), auch nach dem Umbau auf Räume
      // — dmRoomId() ist eine reine Funktion, funktioniert also auch ohne
      // dass der DM-Raum mit `fromFp` hier schon lokal bekannt/ensureRoom()t ist.
      if (!isRoomMuted(dmRoomId(qu.fingerprint, fromFp))) startRingtone();
    });
    onRoutedEvent(currentChannel, 'call-decline', (msg) => {
      if (activeCall?.peerFp === msg.from) endCall(msg.payload?.reason === 'busy' ? 'busy' : 'declined', { notifyPeer: false });
    });
    onRoutedEvent(currentChannel, 'call-hangup', (msg) => {
      if (activeCall?.peerFp === msg.from) endCall('peer-hangup', { notifyPeer: false });
    });
  }

  // --- Start ---
  renderRoomList();
  for (const r of rooms) {
    ensureRoom(r.id)
      .then(() => {
        if (!isGroupRoom(r) && !roomDisplayAvatar(r)) avatarFor(r.members[0]).then((url) => { if (url) renderRoomList(); });
      })
      .catch((e) => console.error('[chat] ensureRoom failed:', r.id, e));
  }
  window.addEventListener('beforeunload', () => { for (const stop of stopHeartbeatByRoom.values()) stop(); });
  // Zusätzlich zu 'beforeunload' — das feuert auf Mobile-Browsern oft gar
  // nicht zuverlässig (u. a. iOS Safari beim Wischen zum Schließen), 'pagehide'
  // dagegen so gut wie immer, auch aus dem bfcache heraus.
  window.addEventListener('pagehide', () => { for (const stop of stopHeartbeatByRoom.values()) stop(); });

}

main().catch((e) => {
  statusBar.textContent = `Fehler: ${e.message}`;
  statusBar.classList.add('err');
  console.error(e);
});
