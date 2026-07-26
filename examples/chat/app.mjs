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
  createSpaceMembershipPlugin, inboxId, createProfilesPlugin, DIRECTORY_ID, LocalStorageAdapter,
} from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import {
  dmRoomId, groupRoomId, normalizeFingerprint, shortFp, fmtBytes, fmtTime, fmtDayLabel,
  linkify, mediaKind, sortByActivity, buildPath, parsePathSegments, fmtCallDuration,
  buildLocationUrl, parseLocationFromUrl, staticMapTileUrl, isVoiceMessageFilename,
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
//
// Beide sind seit Kurzem ECHTE QU-Spaces unter der eigenen Identität
// (`qu.own.get('contacts')`/`get('rooms')`, siehe main()) — nur privat
// (Core-Default-ACL: ausschließlich der Besitzer selbst lesbar/schreibbar,
// src/core/identity-acl.js), damit Änderungen reaktiv sind (eine zentrale
// Subscription statt verstreuter manueller renderRoomList()-Aufrufe nach
// jedem upsertRoom()/upsertContact()) UND automatisch über mehrere Geräte
// derselben Identität synchronisieren. CONTACTS_KEY/ROOMS_KEY bleiben
// trotzdem bestehen — als lokaler, sofort verfügbarer Cache (Local-First:
// die Chat-Liste soll auch komplett offline sofort erscheinen, nicht erst
// nachdem eine Relay-Verbindung steht und synchronisiert hat).
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
// (Fingerprints AUSSER einem selbst), lastTs, unread, lastPreview, lastMine,
// muted, encrypted }`.
const ROOMS_KEY = 'qu-chat-rooms';
const SOUND_MESSAGES_KEY = 'qu-chat-sound-messages';
const SOUND_CALLS_KEY = 'qu-chat-sound-calls';
const PENDING_DELIVERY_KEY = 'qu-chat-pending-delivery'; // siehe confirmDelivery() weiter unten
// Default AN (bisheriges Verhalten unverändert) — siehe renderAttachment()
// weiter unten für den Ein-Klick-statt-automatisch-Fall bei AUS.
const AUTO_LOAD_MEDIA_KEY = 'qu-chat-auto-load-media';
// Default AUS — der Tages-Trenner in der Liste zeigt das Datum bereits
// einmal pro Tag, an jeder einzelnen Nachricht wäre es meist redundant.
const SHOW_DATE_KEY = 'qu-chat-show-date';
// Kartenanbieter für den 📍-Button (Standort teilen) — 'osm' (Default,
// braucht keinen eigenen API-Key/Account) | 'google' | 'apple' | 'custom'
// (MAP_CUSTOM_URL_KEY liefert dann das URL-Template mit {lat}/{lng},
// siehe buildLocationUrl() in chat-lib.mjs).
const MAP_PROVIDER_KEY = 'qu-chat-map-provider';
const MAP_CUSTOM_URL_KEY = 'qu-chat-map-custom-url';
// Default AUS — anders als jede andere Einstellung hier (die alle einen
// Default AN haben) ist "wer online ist" persönliche Information über den
// eigenen Aufenthalt/Gerätezustand, die man erst bewusst freigeben sollte,
// nicht automatisch von der ersten Sekunde an. Betrifft nur das eigene
// SENDEN des "online"-Heartbeats (ensureRoom() unten) — ob man SELBST den
// Online-Status anderer Mitglieder sieht (renderPresence()), ist davon
// unabhängig und bleibt immer an, das ist reines Lesen, keine Preisgabe.
const PRESENCE_SHARING_KEY = 'qu-chat-presence-sharing';
// Ablagefach für geteilte Inhalte zwischen sw.js's handleShareTarget()
// (schreibt) und showShareTargetScreen() unten (liest + löscht) — siehe
// dessen Doku. Auch der Träger für den Opt-out-Schalter unten: localStorage
// ist aus einem Service Worker heraus NICHT lesbar (kein synchroner Zugriff
// im SW-Global-Scope), Cache Storage dagegen schon — derselbe Cache trägt
// deshalb zusätzlich einen kleinen `/share-target-enabled`-Eintrag als
// Spiegel des unten stehenden localStorage-Werts.
const SHARE_CACHE_NAME = 'qu-chat-share-target';
// Default AN (anders als die übrigen Datenschutz-Schalter hier) — Teilen
// funktioniert ohne diese Einstellung überhaupt zu berühren bereits wie
// erwartet; wer NICHT will, dass Android/iOS QU Chat im System-"Teilen"-
// Dialog anbietet, kann hier bewusst abschalten. Wichtig: das entfernt QU
// Chat NICHT aus diesem Dialog selbst (das steuert das Betriebssystem
// anhand des installierten manifest.webmanifest, nicht diese Laufzeit-
// Einstellung) — es sorgt aber dafür, dass ein trotzdem eingehender Share
// von sw.js's handleShareTarget() sofort verworfen wird, BEVOR irgendein
// Byte des geteilten Inhalts überhaupt in einen Cache geschrieben wird.
const SHARE_TARGET_KEY = 'qu-chat-share-target-enabled';
// Enger als modules/chat.js's eigene Defaults (8s/20s) — ein Kontakt soll
// sichtbar zügig als "offline" erkannt werden, nicht erst nach bis zu 20s
// Unschärfe. 3x Heartbeat als Stale-Schwelle lässt trotzdem genug
// Spielraum für einen einzelnen verpassten Tick (Netzwerk-Ruckler), ohne
// bei jedem kleinen Hänger fälschlich "offline" zu blinken.
const PRESENCE_HEARTBEAT_MS = 5_000;
const PRESENCE_STALE_MS = 15_000;

// Alle oben stehenden *_KEY-Konstanten laufen ab hier über Qu's eigenen
// StorageAdapter statt direkter `localStorage.getItem()/.setItem()`-Aufrufe
// — derselbe Adapter, den auch Qu selbst als StorageAdapter für einen
// QuStore verwenden könnte (get/put/delete/getAll/clear), hier einfach
// standalone für App-Einstellungen genutzt. Leerer Namespace: hält jeden
// bestehenden localStorage-Key exakt beim bisherigen Namen (kein `qu:`-
// Präfix), damit dieser Umbau kein bereits gespeichertes Adressbuch/
// Chat-Liste/... stillschweigend verwaist.
const storage = new LocalStorageAdapter({ namespace: '' });

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
const replyPreviewEl = $('reply-preview');
const replyPreviewAuthorEl = $('reply-preview-author');
const replyPreviewTextEl = $('reply-preview-text');
const replyCancelBtn = $('reply-cancel-btn');
const messageActionsMenuEl = $('message-actions-menu');
const msgActionReplyBtn = $('msg-action-reply');
const msgActionEditBtn = $('msg-action-edit');
const msgActionForwardBtn = $('msg-action-forward');
const msgActionShareBtn = $('msg-action-share');
const msgActionCopyBtn = $('msg-action-copy');
const msgActionCopyLinkBtn = $('msg-action-copy-link');
const pendingFilesEl = $('pending-files');
const extrasToggleBtn = $('extras-toggle-btn');
const composerExtras = $('composer-extras');
const locationBtn = $('location-btn');
const voiceBtn = $('voice-btn');
const voiceRecorderEl = $('voice-recorder');
const voiceDiscardBtn = $('voice-discard-btn');
const voiceStatusEl = $('voice-status');
const voiceTimerEl = $('voice-timer');
const voicePreviewAudio = $('voice-preview-audio');
const voiceStartBtn = $('voice-start-btn');
const voicePauseBtn = $('voice-pause-btn');
const voiceResumeBtn = $('voice-resume-btn');
const voiceStopBtn = $('voice-stop-btn');
const voiceSendBtn = $('voice-send-btn');
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
const autoLoadMediaToggle = $('auto-load-media-toggle');
const showDateToggle = $('show-date-toggle');
const mapProviderSelect = $('map-provider-select');
const mapCustomUrlRow = $('map-custom-url-row');
const mapCustomUrlInput = $('map-custom-url-input');
const presenceSharingToggle = $('presence-sharing-toggle');
const shareTargetToggle = $('share-target-toggle');

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
const shareTargetModal = $('share-target-modal');
const shareTargetSummaryEl = $('share-target-summary');
const shareTargetRoomListEl = $('share-target-room-list');
const shareTargetErrorEl = $('share-target-error');
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

// --- "➕"-Popup für 📎/📍/🎤 auf Handy-Breite (style.css's 760px-Breakpoint
// klappt .composer-extras dafür von "läuft normal in der Zeile mit" auf
// "Popup über der Eingabezeile" um) — dieselbe attach-btn/location-btn/
// voice-btn-Elemente wie in der breiten Ansicht, nur die JS-Sichtbarkeits-
// steuerung des Popups selbst kommt hier dazu. Unterhalb des Breakpoints
// ist extrasToggleBtn per CSS ausgeblendet, ein Klick darauf also ohnehin
// unmöglich — kein zusätzlicher Breite-Check hier nötig.
extrasToggleBtn.addEventListener('click', () => composerExtras.classList.toggle('open'));
document.addEventListener('click', (ev) => {
  if (composerExtras.classList.contains('open') && !composerExtras.contains(ev.target) && ev.target !== extrasToggleBtn) {
    composerExtras.classList.remove('open');
  }
});
// Nach der Wahl einer Aktion (Anhang/Standort/Sprachnachricht) schließt
// sich das Popup von selbst, statt offen stehen zu bleiben, bis irgendwo
// daneben getippt wird.
composerExtras.addEventListener('click', (ev) => { if (ev.target.closest('button')) composerExtras.classList.remove('open'); });

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

// Adressbuch/Chat-Liste/Mute sind jetzt echte QU-Spaces unter der eigenen
// Identität, nicht mehr nur lokales StorageAdapter-Array — siehe deren
// Aufbau weiter unten in main() (dort steht auch, warum: qu.own setzt
// eine Identität voraus, die vor main() noch nicht existiert, kein reines
// Top-Level-await möglich). upsertContact()/upsertRoom()/roomById()/
// contactByFp()/isGroupRoom()/roomDisplayName()/roomDisplayAvatar()/
// isRoomMuted()/setRoomMuted() sind entsprechend jetzt dort definiert.

// --- Verschlüsselung pro Chat: fest an, kein Opt-out ---
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
// `encryptFor: [eigener Fingerprint, Peer/Mitglieder]` statt sich auf die
// automatische Ableitung zu verlassen. Ein früherer Opt-out (Verschlüsselung
// pro Chat abschaltbar) wurde entfernt — schon gesendete Nachrichten bleiben
// für immer im Modus, in dem sie geschrieben wurden, ein Hin-und-Her hätte
// beide Zustände unsichtbar für die Nutzerin in einem Chat gemischt.
// isRoomEncrypted() (main()) liefert daher jetzt unbedingt `true`,
// chat-encryption-toggle (index.html) ist entsprechend `disabled`.

// --- "Beim Relay angekommen?"-Status eigener Nachrichten (siehe
// confirmDelivery() weiter unten) ---
// Persistiert (nicht nur im Speicher), WEIL genau der Fall zählt, den
// dieses Feature adressiert: ein Upload, dessen Bestätigung noch nicht da
// war, als das Gerät ausgeschaltet/die Seite geschlossen wurde — ohne
// Persistenz würde der nächste Appstart einfach vergessen, dass da noch
// etwas unbestätigt in der Luft hängt, und die UI zeigte dauerhaft (fälschlich)
// "gesendet" statt es beim nächsten Verbindungsaufbau erneut zu prüfen.
async function loadPendingDeliveries() {
  return (await storage.get(PENDING_DELIVERY_KEY)) ?? [];
}
async function savePendingDeliveries(list) {
  await storage.put(PENDING_DELIVERY_KEY, list);
}

// --- Töne (Web Audio API, synthetisiert — kein externes Audio-Asset
// nötig, funktioniert also ohne jeden zusätzlichen Download/Lizenzfrage) ---
// Ein/Aus je Ereignistyp global (SOUND_MESSAGES_KEY/SOUND_CALLS_KEY,
// Default "an" bei fehlendem Eintrag), zusätzlich pro Chat stumm
// schaltbar (room.muted, siehe isRoomMuted()/setRoomMuted() in main())
// — beides zusammen ergibt "Nachrichtenton an, aber dieser eine Chat
// stumm" ODER "dieser Chat nicht stumm, aber
// Töne insgesamt aus", unabhängig voneinander einstellbar.
// Werte hier sind bewusst KEIN JSON (nur '0'/'1') — get()/put() unten
// gehen trotzdem über denselben Adapter wie alles andere, JSON.stringify('1')
// bzw. JSON.parse('"1"') sind für einen einzelnen String-Wert unauffällig,
// sparen sich hier aber keine eigene Sonderbehandlung.
async function soundEnabled(key) { return (await storage.get(key)) !== '0'; }
async function setSoundEnabled(key, enabled) { await storage.put(key, enabled ? '1' : '0'); }

// --- Medien automatisch laden (Bandbreite/mobiles Datenvolumen schonen) ---
// Default AN — bisheriges Verhalten bleibt Standard; abschaltbar für alle,
// die lieber selbst entscheiden, wann ein Anhang tatsächlich heruntergeladen
// wird. Gilt für JEDEN Anhang-Typ (nicht nur Bild/Video) — reveal() lädt für
// Audio/generische Dateien exakt denselben vollen Byte-Download, nur die
// Darstellung danach unterscheidet sich; diese Einstellung schont also
// tatsächliches Datenvolumen, nicht nur Bild-/Videowiedergabe.
async function autoLoadMedia() { return (await storage.get(AUTO_LOAD_MEDIA_KEY)) !== '0'; }
async function setAutoLoadMedia(enabled) { await storage.put(AUTO_LOAD_MEDIA_KEY, enabled ? '1' : '0'); }
async function showDateInMessages() { return (await storage.get(SHOW_DATE_KEY)) === '1'; }
async function setShowDateInMessages(enabled) { await storage.put(SHOW_DATE_KEY, enabled ? '1' : '0'); }

// --- Standort teilen: welcher Kartenanbieter (App-Einstellungen) ---
async function mapProvider() { return (await storage.get(MAP_PROVIDER_KEY)) || 'osm'; }
async function setMapProvider(provider) { await storage.put(MAP_PROVIDER_KEY, provider); }
async function mapCustomUrlTemplate() { return (await storage.get(MAP_CUSTOM_URL_KEY)) || ''; }
async function setMapCustomUrlTemplate(template) { await storage.put(MAP_CUSTOM_URL_KEY, template); }

// --- Online-Status teilen: Default AUS (s. PRESENCE_SHARING_KEY oben) ---
async function presenceSharingEnabled() { return (await storage.get(PRESENCE_SHARING_KEY)) === '1'; }
async function setPresenceSharingEnabled(enabled) { await storage.put(PRESENCE_SHARING_KEY, enabled ? '1' : '0'); }

// --- "Teilen an QU Chat" (Web Share Target) an-/abschaltbar: Default AN ---
async function shareTargetEnabled() { return (await storage.get(SHARE_TARGET_KEY)) !== '0'; }
/**
 * Persistiert UND spiegelt sofort in den SHARE_CACHE_NAME-Cache (sw.js's
 * einzige Möglichkeit, diesen Wert zu lesen — kein localStorage-Zugriff
 * aus einem Service Worker heraus). Ohne dieses Spiegeln würde ein
 * frisch abgeschalteter Schalter erst nach dem nächsten vollständigen
 * App-Start wirken (siehe syncShareTargetFlagToCache()-Aufruf in main()),
 * statt sofort einen laufenden Share-Versuch zu blockieren.
 */
async function setShareTargetEnabled(enabled) {
  await storage.put(SHARE_TARGET_KEY, enabled ? '1' : '0');
  await syncShareTargetFlagToCache(enabled);
}
async function syncShareTargetFlagToCache(enabled) {
  if (!('caches' in window)) return;
  const cache = await caches.open(SHARE_CACHE_NAME);
  await cache.put('/share-target-enabled', new Response(enabled ? '1' : '0'));
}

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

async function playMessageSound() {
  if (!(await soundEnabled(SOUND_MESSAGES_KEY))) return;
  playTone([880, 1318.5], { duration: 0.18, gain: 0.12 }); // A5 -> E6, kurzer aufsteigender "Ping"
}

let ringtoneTimer = null;
async function startRingtone() {
  if ((!(await soundEnabled(SOUND_CALLS_KEY))) || ringtoneTimer) return;
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

  // Vor die Raum-/Kontakt-Subscription unten gezogen (stand früher weiter
  // unten, bei den anderen Pro-Sitzung-Maps) — deren `.map(..., {initial:
  // true})`-Erstbefüllung läuft zwar erst einen Mikrotask später, aber
  // eben NUR einen — nicht garantiert NACH allen weiteren synchronen
  // Deklarationen dieser Funktion. `activeRoomId` muss also VOR dieser
  // Subscription initialisiert sein, sonst ein "Cannot access before
  // initialization" (TDZ), sobald bereits ein Raum/Kontakt lokal bekannt
  // ist und sofort ausgeliefert wird.
  let activeRoomId = null;

  // --- Adressbuch + Chat-Liste: private QU-Spaces unter der eigenen
  // Identität (siehe CONTACTS_KEY/ROOMS_KEY-Doku oben) ---
  // `qu.own` setzt eine bereits existierende Identität voraus — deshalb
  // erst HIER (nicht als Top-Level-await wie vor diesem Umbau) und nicht
  // mehr rein StorageAdapter-basiert. `rooms`/`contacts` bleiben trotzdem
  // simple, synchron lesbare Arrays (fast jeder Aufrufer im Rest dieser
  // Datei erwartet genau das, u. a. ensureRoom()s `roomById(roomId)`
  // DIREKT nach upsertRoom() — kein "erst noch auf die Subscription
  // warten" möglich, ohne jeden Aufrufer async umzubauen).
  //
  // applyRoomChange()/applyContactChange() sind die EINZIGE Stelle, die
  // `rooms`/`contacts` mutiert und Rendering anstößt — aufgerufen sowohl
  // SOFORT/synchron von upsertRoom()/upsertContact() (optimistisch, für
  // den eigenen, gerade ausgelösten Schreibvorgang) ALS AUCH später,
  // erneut, von der `.map()`-Subscription unten (für alles, was NICHT von
  // hier kam: ein zweites Gerät derselben Identität, oder ein aus dem
  // lokalen Cache/Relay nachgeladener älterer Stand). Ein zweites Mal mit
  // identischem Inhalt anzuwenden ist ein reines No-Op fürs Rendering,
  // kein Sonderfall nötig.
  const roomsSpace = qu.own.get('rooms');
  const contactsSpace = qu.own.get('contacts');
  const rooms = (await storage.get(ROOMS_KEY)) ?? []; // lokaler Cache, sofort verfügbar — auch komplett offline, bevor irgendeine Relay-Sync gelaufen ist
  const contacts = (await storage.get(CONTACTS_KEY)) ?? [];

  /**
   * `renderRoomList()`/`renderRoomHeader()`/`renderPresence()` sowie
   * mehrere `const`/`let`-Zustände, die sie selbst lesen (u. a.
   * `activeRoomId`, `presenceStaleTimerByRoom`), sind erst WEITER UNTEN in
   * main() deklariert — hier nur referenziert, nicht aufgerufen. Function-
   * Deklarationen sind innerhalb von main() zwar vollständig gehoben
   * (aufrufbar ab der allerersten Zeile), aber die `const`/`let`-Bindungen,
   * die ihr KÖRPER liest, haben eine echte TDZ. Deshalb unten bewusst
   * `initial: false` (statt map()s Default `initial: true`) — die
   * Erstbefüllung EINES bereits vorhandenen QuBits liefe sonst asynchron,
   * aber eben nicht garantiert NACH allen weiteren synchronen
   * Deklarationen dieser Funktion (subscribe-with-options.js's `initial`-
   * Pfad braucht nur EINEN Mikrotask, main()s eigener Rest kann durchaus
   * länger brauchen — ein "Cannot access before initialization" wäre die
   * Folge). Kein Funktionsverlust: der lokale Store ist an dieser frühen
   * Stelle ohnehin noch leer (MemoryAdapter, frisch bei jedem Reload) —
   * nichts Relevantes existiert schon VOR dieser Subscription, alles
   * Künftige (eigene Schreibvorgänge, ein zweites Gerät derselben
   * Identität über repl.sync()) kommt über denselben `ingest()`-Pfad
   * herein wie jede andere Netzwerk-Zustellung auch und wird von einer
   * bereits AKTIVEN Subscription genauso zuverlässig geliefert.
   */
  function applyRoomChange(id, value) {
    const i = rooms.findIndex((r) => r.id === id);
    if (value === null) { if (i !== -1) rooms.splice(i, 1); }
    else if (i === -1) rooms.push(value);
    else rooms[i] = value;
    storage.put(ROOMS_KEY, rooms); // Cache für den nächsten (evtl. offline) Start aktuell halten
    renderRoomList();
    if (activeRoomId === id) { renderRoomHeader(roomById(id)); renderPresence(id); }
  }
  function applyContactChange(fp, value) {
    const i = contacts.findIndex((c) => c.fp === fp);
    if (value === null) { if (i !== -1) contacts.splice(i, 1); }
    else if (i === -1) contacts.push(value);
    else contacts[i] = value;
    storage.put(CONTACTS_KEY, contacts);
    renderRoomList();
    const activeRoom = activeRoomId ? roomById(activeRoomId) : null;
    if (activeRoom && !isGroupRoom(activeRoom) && activeRoom.members[0] === fp) renderRoomHeader(activeRoom);
  }
  // `raw: true` (roher Vergleich statt key://-Auflösung) genügt hier — wir
  // zeigen nie auf einen anderen Space um, siehe core/space-handle.js's
  // map()-Doku. Vermeidet den sonst eingebauten Mikrotask-Umweg über
  // resolveDispatch()/subscribeDispatch(), unnötig für ein rein lokales
  // `qu.own`-Unterverzeichnis. `initial: false` — siehe applyRoomChange()s
  // Doku oben für das Warum.
  roomsSpace.map((q) => applyRoomChange(q.id.slice(roomsSpace.id.length + 1), q.value), { initial: false, raw: true });
  contactsSpace.map((q) => applyContactChange(q.id.slice(contactsSpace.id.length + 1), q.value), { initial: false, raw: true });

  function contactByFp(fp) {
    return contacts.find((c) => c.fp === fp) ?? null;
  }
  /**
   * Aktualisiert `contacts` SOFORT/synchron (applyContactChange()) UND
   * schreibt fire-and-forget über den Space, damit der Wert dauerhaft ist
   * und auf andere Geräte derselben Identität synct. Ohne den sofortigen
   * Teil würde z. B. `ensureRoom()`s `roomById(roomId)` (das direkte
   * Aufrufer wie startDm() sofort danach erwarten) bis zum Eintreffen der
   * Subscription — mehrere Mikrotasks später — `null` liefern.
   */
  function upsertContact(fp, patch) {
    const value = { fp, alias: shortFp(fp), ...contactByFp(fp), ...patch };
    applyContactChange(fp, value);
    contactsSpace.get(fp).put(value, { raw: true });
  }

  function roomById(id) {
    return rooms.find((r) => r.id === id) ?? null;
  }
  /** Dasselbe Muster wie upsertContact() — siehe dessen Doku. */
  function upsertRoom(id, patch) {
    const value = { id, name: null, members: [], lastTs: 0, unread: 0, muted: false, encrypted: true, ...roomById(id), ...patch };
    applyRoomChange(id, value);
    roomsSpace.get(id).put(value, { raw: true });
  }
  /** Kein echtes Löschen (QuBits sind unveränderlich) — ein Tombstone (`put(null)`), dasselbe Muster wie todo-lib.mjs's deleteItem()/profiles.js's deleteProfileAttr(). */
  function removeRoomEntry(id) {
    applyRoomChange(id, null);
    roomsSpace.get(id).put(null, { raw: true });
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
  function isRoomMuted(roomId) { return roomById(roomId)?.muted ?? false; }
  function setRoomMuted(roomId, muted) { upsertRoom(roomId, { muted }); }
  // Forced Encryption: kein Opt-out mehr (siehe chat-encryption-toggle in
  // index.html, jetzt `disabled` — die Möglichkeit, Verschlüsselung pro
  // Chat abzuschalten und wieder einzuschalten, konnte zu inkonsistentem
  // Zustand führen: schon gesendete Nachrichten bleiben unverändert in
  // ihrem jeweiligen Modus, ein Hin-und-Her mischt beide Zustände in
  // einem Chat, ohne dass das für die Nutzerin sichtbar wäre). Ein
  // historisch per Storage gespeichertes `encrypted: false` (aus einer
  // älteren Version) wird hier bewusst NICHT mehr gelesen — jeder Chat
  // gilt ab sofort als verschlüsselt.
  function isRoomEncrypted() { return true; }

  registerServiceWorker(); // so früh wie möglich, unabhängig von der restlichen Chat-Initialisierung — siehe dessen Doku oben
  // Cache-Spiegel (sw.js's einzige Lesequelle für diesen Schalter, s.
  // setShareTargetEnabled()) beim Start IMMER neu aus dem persistierten
  // Wert aufbauen — nicht nur bei einer tatsächlichen Änderung, sonst
  // bliebe ein gelöschter/nie befüllter Cache (z. B. nach "App
  // zurücksetzen" oder auf einem neuen Gerät) fälschlich beim
  // sw.js-seitigen Default statt beim wirklich gespeicherten Wert.
  shareTargetEnabled().then(syncShareTargetFlagToCache).catch(() => {});

  meFpShortEl.textContent = shortFp(qu.fingerprint, 10) + '…';
  const savedAlias = await storage.get(ALIAS_KEY);
  setAvatar(meAvatarBtn, savedAlias || qu.fingerprint);
  let myAlias = savedAlias || `Ich-${qu.fingerprint.slice(0, 4)}`;
  let myAvatar = null;
  meNameEl.textContent = myAlias;
  setAvatar(meAvatarBtn, myAlias);

  // --- Pro-Raum-Zustand (alle Maps roomId-geschlüsselt — EIN Raum kann
  // 1:1 ODER Gruppe sein, siehe ROOMS_KEY oben; der Code hier unterscheidet
  // beide nicht mehr) ---
  // VOR ensureAlias()/connectToRelay() (unten) deklariert, nicht erst
  // danach: renderPresence()/renderRoomHeader() (von applyRoomChange()/
  // applyContactChange() oben aufgerufen, sobald irgendeine Raum-/Kontakt-
  // Änderung ankommt) lesen presenceStaleTimerByRoom u. a. — ensureAlias()
  // ruft bereits repl.sync({ topic: qu.userSpaceId }) auf, was (bei einer
  // wiederkehrenden Identität mit bereits vorhandenen rooms/contacts auf
  // dem Relay) die Raum-/Kontakt-Subscription oben schon auslösen kann,
  // BEVOR diese Maps sonst existiert hätten — dieselbe TDZ-Falle wie bei
  // `activeRoomId` oben, nur eine Ebene tiefer.
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
    let alias = await storage.get(ALIAS_KEY);
    if (!alias) {
      alias = prompt('Dein Anzeigename:', `Ich-${qu.fingerprint.slice(0, 4)}`) || `Ich-${qu.fingerprint.slice(0, 4)}`;
      await storage.put(ALIAS_KEY, alias);
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
  // "gesendet" (<qu-msg-tick> weiter unten), genau wie vor diesem Feature.
  const deliveredMsgIds = new Set();
  let pendingDeliveries = await loadPendingDeliveries();

  /**
   * Prüft für EINE eigene Nachricht (+ ihre Anhänge), ob sie inzwischen
   * beim Relay angekommen ist — über die neue DefaultReplication#
   * waitUntilReplicated() (für die Nachricht selbst) und die schon
   * bestehende DefaultFileTransfer#waitUntilReady() (für jeden Anhang:
   * "hat der Relay wirklich ALLE Chunks", nicht nur das Manifest). Beide
   * pollen mit Backoff über das Netzwerk (bis zu 20s pro Aufruf). Läuft
   * diese Wartezeit ab, bleibt der Eintrag einfach in pendingDeliveries
   * stehen — sowohl jeder (Wieder-)Verbindungsaufbau (siehe
   * connectToRelay()) als auch der periodische Sweep direkt unter dieser
   * Funktion rufen ihn dann erneut auf, unbegrenzt, bis es klappt oder
   * der Nutzer den Chat löscht. Der Sweep ist der wichtigere der beiden
   * Fälle für einen großen Anhang: eine KONSTANT offene, nur langsame
   * Verbindung erzeugt nie einen Reconnect, aber "der Relay braucht
   * länger als 20s, um alles zu spiegeln" ist für ein echtes Video über
   * eine schwache Verbindung eher die Regel als die Ausnahme.
   */
  // Welche Einträge GERADE geprüft werden — mit mehreren Anhängen kann ein
  // einzelner confirmDelivery()-Aufruf (sequenziell bis zu 20s PRO Ref)
  // länger dauern als der periodische Sweep unten (alle 15s) auseinander
  // liegt. Ohne diese Sperre würde der Sweep für denselben Eintrag einen
  // zweiten, redundanten Aufruf parallel lostreten, statt auf den schon
  // laufenden zu warten.
  const confirmInFlight = new Set();

  // Chunk-genauer Fortschritt "x/y" pro eigener Nachricht, solange sie noch
  // in pendingDeliveries steht — gefüllt aus fileTransfer.waitUntilReady()s
  // `onProgress` (have/total, siehe data/files/transfer.js's readiness-
  // Protokoll-Erweiterung) und über tickBus (siehe dort) ins Sync-Badge
  // geschrieben. Bei MEHREREN Anhängen zeigt das Badge den GERADE laufenden
  // (Index unter `ref`), nicht eine über alle Anhänge aggregierte Zahl —
  // Chunks unterschiedlicher Anhänge zu einer einzigen Prozentzahl zu
  // addieren würde nur vortäuschen, hier stünde eine echte Gesamtgröße
  // dahinter.
  const syncProgressByMsgId = new Map(); // msgId -> { refIndex, refCount, have, total }

  /**
   * Ersetzt das frühere `renderTicks(roomId)`, das an ca. 10 Stellen von
   * Hand aufgerufen werden musste, immer hinter einem
   * `if (activeRoomId === roomId)`-Wächter. Statt zentral zu rendern,
   * bringt jede eigene Nachricht ihr eigenes `<qu-msg-tick>`/
   * `<qu-sync-badge>` (siehe unten) mit, das sich beim Einhängen ins DOM
   * selbst auf `tickBus` abonniert und sich beim Aushängen wieder
   * abmeldet — nur Elemente, die gerade wirklich sichtbar sind (der
   * offene Chat), hören überhaupt zu, ganz ohne dass ein Aufrufer noch an
   * `activeRoomId` denken muss.
   */
  const tickBus = new EventTarget();
  function notifyTicks(roomId) {
    tickBus.dispatchEvent(new CustomEvent('tick-change', { detail: { roomId } }));
  }

  /**
   * Hält den Bildschirm wach (Screen Wake Lock API), SOLANGE mindestens
   * eine Anhang-Übertragung läuft (eigener Upload-Sync via
   * confirmDelivery() unten, oder ein Download via renderAttachment()s
   * reveal()) — ein großer Video-Anhang über eine schwache Verbindung
   * kann Minuten brauchen; schaltet sich das Display währenddessen ab,
   * pausiert (je nach Gerät/Browser) oft auch die laufende Übertragung
   * selbst. Referenzgezählt (`activeTransfers`), nicht ein einfaches
   * Ja/Nein-Flag — mehrere gleichzeitige Übertragungen (z. B. Senden UND
   * gleichzeitig einen anderen Anhang laden) dürfen sich nicht gegenseitig
   * das Lock vorzeitig freigeben. Kein Fehler, wenn die API fehlt (ältere
   * Safari-Versionen) — dann bleibt es schlicht wirkungslos, wie bisher.
   */
  let wakeLock = null;
  let activeTransfers = 0;
  async function beginTransfer() {
    activeTransfers++;
    if (activeTransfers === 1 && 'wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { console.warn('[chat] Screen Wake Lock nicht verfügbar:', e.message); }
    }
  }
  function endTransfer() {
    activeTransfers = Math.max(0, activeTransfers - 1);
    if (activeTransfers === 0 && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  // Ein Wake Lock wird vom Browser automatisch freigegeben, sobald der Tab
  // in den Hintergrund wechselt (Spezifikation) — kommt er zurück, während
  // noch eine Übertragung läuft, muss es explizit neu angefordert werden,
  // sonst bliebe das Display ab hier dauerhaft ungeschützt, obwohl
  // `activeTransfers` weiterhin > 0 ist.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && activeTransfers > 0 && !wakeLock && 'wakeLock' in navigator) {
      try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* z. B. Tab doch nicht wirklich sichtbar — nächster Wechsel versucht es erneut */ }
    }
  });

  async function confirmDelivery(entry) {
    if (deliveredMsgIds.has(entry.id) || confirmInFlight.has(entry.id)) return;
    if (!channel?.isOpen()) return; // nichts zu prüfen gerade — nächster Reconnect/Sweep versucht es erneut
    confirmInFlight.add(entry.id);
    const refs = entry.refs ?? [];
    if (refs.length) await beginTransfer(); // nur bei einem echten Anhang wach halten — eine reine Text-Nachricht synct praktisch sofort
    try {
      const msgOk = await repl.waitUntilReplicated(entry.id, { ts: entry.ts, maxWaitMs: 20000 });
      if (!msgOk) return;
      for (let i = 0; i < refs.length; i++) {
        const ready = await fileTransfer.waitUntilReady(refs[i], {
          maxWaitMs: 20000,
          onProgress: ({ have, total }) => {
            if (!total) return; // 0/0 heißt hier "Anfrage fehlgeschlagen", nicht "0 von 0 Chunks" — nichts Sinnvolles zum Anzeigen
            syncProgressByMsgId.set(entry.id, { refIndex: i, refCount: refs.length, have, total });
            notifyTicks(entry.roomId);
          },
        });
        if (!ready) return;
      }
    } catch (e) {
      console.error('[chat] confirmDelivery fehlgeschlagen:', entry.id, e);
      return;
    } finally {
      confirmInFlight.delete(entry.id);
      if (refs.length) endTransfer();
    }
    syncProgressByMsgId.delete(entry.id);
    deliveredMsgIds.add(entry.id);
    pendingDeliveries = pendingDeliveries.filter((p) => p.id !== entry.id);
    savePendingDeliveries(pendingDeliveries);
    notifyTicks(entry.roomId);
  }

  // Periodischer Sicherheitsnetz-Sweep: confirmDelivery() selbst gibt nach
  // 20s Polling pro Prüfung auf (siehe dessen eigene Doku) — bei einer
  // KONSTANT offenen, aber langsamen Verbindung (großer Videoanhang über
  // eine schwache Mobilfunkverbindung, der länger als 20s braucht, um
  // vollständig zum Relay gespiegelt zu werden) fällt dann NIE ein echter
  // Reconnect an, der laut derselben Doku "es beim nächsten Mal erneut
  // versucht" — der Eintrag blieb dadurch für immer in pendingDeliveries
  // hängen und das Sync-Badge (<qu-sync-badge>) verschwand nie, obwohl der
  // Upload am Ende wirklich fertig war. Dieses Intervall schließt genau
  // diese Lücke, unabhängig davon, ob die Verbindung je abreißt.
  setInterval(() => {
    for (const entry of pendingDeliveries) confirmDelivery(entry).catch(() => {});
  }, 15000);

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
    shareTargetModal.hidden = true;
    newGroupModal.hidden = true;
    chatSettingsModal.hidden = true;
  }

  const ROOT_ROUTES = {
    profile: () => showProfileScreen(),
    settings: () => showAppSettingsScreen(),
    search: () => showSearchScreen(),
    'add-contact': (prefillFp) => showAddContactScreen(prefillFp),
    share: (id) => showShareTargetScreen(id),
    'share-blocked': () => showShareBlockedScreen(),
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
      notifyTicks(roomId);
    }));
    // Gruppenname: ein normaler LWW-Wert AM Raum selbst (`${roomId}/meta`),
    // nicht nur lokal in `rooms` — jede Umbenennung (renameGroupRoom()
    // unten) synct so automatisch zu jedem Mitglied, genau wie Alias/
    // Presence. Bei einem DM bleibt dieser Knoten schlicht ungenutzt
    // (roomDisplayName() liest den Namen dort ohnehin nie für einen DM).
    unsubs.push(qu.get(roomId).get('meta').on((q) => {
      if (typeof q?.value?.name !== 'string') return;
      upsertRoom(roomId, { name: q.value.name }); // löst renderRoomList()/renderRoomHeader() selbst über die zentrale rooms-Subscription aus (siehe main())
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
        upsertContact(memberFp, { avatar: url }); // löst renderRoomList()/renderRoomHeader() selbst über die zentrale contacts-Subscription aus (siehe main())
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
        upsertContact(memberFp, { alias: name }); // löst renderRoomList()/renderRoomHeader() selbst über die zentrale contacts-Subscription aus (siehe main())
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
    renderPresence(roomId); // Lesen des Online-Status ANDERER ist immer an, unabhängig von presenceSharingEnabled() unten — reines Anzeigen, keine eigene Preisgabe.
    // Eigenen "online"-Heartbeat nur senden, wenn explizit freigegeben (App-
    // Einstellungen, presence-sharing-toggle) — Default AUS, siehe
    // PRESENCE_SHARING_KEY oben. Ohne Freigabe bleibt renderPresence() für
    // andere Mitglieder einfach dauerhaft "offline"/grau für diese Identität.
    if (await presenceSharingEnabled()) {
      stopHeartbeatByRoom.set(roomId, qu.startHeartbeat(roomId, { intervalMs: PRESENCE_HEARTBEAT_MS }));
    }

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
    upsertRoom(roomId, { members: updatedMembers }); // löst renderRoomList()/renderRoomHeader()/renderPresence() selbst über die zentrale rooms-Subscription aus (siehe main())

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
      upsertContact(newFp, { avatar: url }); // löst renderRoomList()/renderRoomHeader() selbst über die zentrale contacts-Subscription aus (siehe main())
    }));
    unsubs.push(qu.get(`~${newFp}`).get('alias').on((q) => {
      if (contactByFp(newFp)?.aliasCustom) return;
      const name = q?.value ?? shortFp(newFp);
      aliasCache.set(newFp, name);
      upsertContact(newFp, { alias: name }); // löst renderRoomList()/renderRoomHeader() selbst über die zentrale contacts-Subscription aus (siehe main())
    }));
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
    upsertRoom(roomId, { members: updatedMembers }); // löst renderRoomList()/renderRoomHeader()/renderPresence() selbst über die zentrale rooms-Subscription aus (siehe main())
  }

  /** Reagiert auf einen eingehenden Briefkasten-Eintrag (siehe ensureRoom() oben) — legt den Raum (und ggf. den Absender als Kontakt) bei Bedarf lokal an, ganz ohne dass die Nutzerin ihn vorher selbst hinzugefügt haben muss. Funktioniert identisch für einen neuen DM UND eine neue/erweiterte Gruppe. */
  function handleInboxRequest(q) {
    const fromFp = q?.value?.fromFp;
    const roomId = q?.value?.id;
    if (!fromFp || fromFp === qu.fingerprint || !roomId) return;
    if (!contactByFp(fromFp)) upsertContact(fromFp, { alias: q.value.alias || shortFp(fromFp) });
    if (!roomById(roomId)) {
      const members = Array.isArray(q.value.members) && q.value.members.length ? q.value.members : [fromFp];
      upsertRoom(roomId, { name: q.value.name ?? null, members }); // löst renderRoomList() selbst über die zentrale rooms-Subscription aus (siehe main())
    }
    ensureRoom(roomId).catch((e) => console.error('[chat] ensureRoom (inbox) failed:', roomId, e));
  }

  function handleIncomingMessage(roomId, q) {
    const seen = seenIdsByRoom.get(roomId);
    if (seen.has(q.id)) return;
    seen.add(q.id);
    const list = messagesByRoom.get(roomId);
    list.push(q);
    list.sort((a, b) => a.ts - b.ts);

    // Eine Bearbeitung (q.value.editOf, s. resolveMessageText()/chat.js's
    // sendMessage()-Doku) ist KEINE eigene, sichtbare Nachricht — kein
    // Vorschau-/Ungelesen-/Ton-/Benachrichtigungs-Update dafür, nur ein
    // Neuaufbau der gerade offenen Liste, falls dieser Raum aktiv ist
    // (damit die Bearbeitung sofort sichtbar wird, statt erst beim
    // nächsten Öffnen des Chats). resolveMessageText() prüft beim
    // Rendern selbst, ob der Schreiber wirklich zur Originalnachricht
    // passt — hier also bewusst KEINE solche Prüfung nötig.
    if (q.value?.editOf) {
      if (activeRoomId === roomId) renderMessageList(roomId);
      // Betrifft die Bearbeitung genau die aktuell letzte ECHTE Nachricht
      // dieses Raums (und stammt wirklich vom selben Schreiber — dieselbe
      // Vertrauensregel wie resolveMessageText()), auch die Vorschau in
      // der Chat-Übersicht nachziehen — sonst zeigt sie dauerhaft die
      // alte Fassung, obwohl der Chat selbst schon die neue anzeigt.
      const lastReal = list.filter((m) => !m.value?.editOf).at(-1);
      if (lastReal && lastReal.id === q.value.editOf && lastReal.writer === q.writer) {
        upsertRoom(roomId, { lastPreview: q.value.text ?? '' });
      }
      return;
    }

    const room = roomById(roomId);
    const mine = q.writer === qu.fingerprint;
    const preview = q.value?.text || (q.refs?.length ? '📎 Anhang' : '');
    const unread = mine || activeRoomId === roomId ? 0 : (room?.unread ?? 0) + 1;
    upsertRoom(roomId, { lastTs: q.ts, lastPreview: preview, lastMine: mine, unread }); // löst renderRoomList() selbst über die zentrale rooms-Subscription aus (siehe main())

    if (activeRoomId === roomId) {
      appendLiveMessage(q, roomId);
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

  /** Badge-Text für EINE eigene Nachricht mit Anhang — mit echtem Chunk-Fortschritt, sobald syncProgressByMsgId etwas für sie weiß, sonst der generische Text (z. B. bevor die erste readiness-Antwort überhaupt eintraf). Gemeinsam genutzt von buildMessageItem() (Anfangszustand) und <qu-sync-badge> (laufende Aktualisierung), damit beide garantiert denselben Text erzeugen. */
  function syncBadgeText(msgId) {
    const p = syncProgressByMsgId.get(msgId);
    if (!p) return '📤 Wird noch mit dem Server synchronisiert — bitte online bleiben, bis dies verschwindet.';
    const percent = Math.round((p.have / p.total) * 100);
    const label = p.refCount > 1 ? ` (Anhang ${p.refIndex + 1}/${p.refCount})` : '';
    return `📤 Wird synchronisiert${label}: Chunk ${p.have}/${p.total} (${percent}%) — bitte online bleiben, bis dies verschwindet.`;
  }

  function stillPendingDelivery(msgId) {
    return pendingDeliveries.some((p) => p.id === msgId) && !deliveredMsgIds.has(msgId);
  }

  /**
   * Kleines ✓/✓✓/🕐-Symbol NEBEN der eigenen Nachricht (buildMessageMetaInline()) —
   * abonniert sich beim Einhängen auf `tickBus` (siehe dessen Doku oben)
   * und meldet sich beim Aushängen wieder ab, statt von außen über
   * renderTicks() angestoßen zu werden.
   */
  class QuMsgTickElement extends HTMLElement {
    connectedCallback() {
      this.className = 'tick';
      this._onChange = (e) => { if (e.detail.roomId === this.dataset.roomId) this.render(); };
      tickBus.addEventListener('tick-change', this._onChange);
      this.render();
    }
    disconnectedCallback() {
      tickBus.removeEventListener('tick-change', this._onChange);
    }
    render() {
      const { id, roomId } = this.dataset;
      const ts = Number(this.dataset.ts);
      const receipts = receiptsByRoom.get(roomId) ?? {};
      // Reihenfolge: gelesen schlägt immer "noch nicht beim Relay
      // bestätigt" (ein Empfänger, der es gelesen hat, hat es zwangsläufig
      // auch empfangen — sonst könnte er es gar nicht gelesen haben,
      // selbst wenn UNSERE eigene waitUntilReplicated()-Prüfung noch
      // aussteht/fehlgeschlagen ist).
      const read = Object.entries(receipts).some(([reader, upTo]) => reader !== qu.fingerprint && upTo >= ts);
      if (read) { this.textContent = '✓✓'; this.classList.add('read'); this.classList.remove('pending'); }
      else if (stillPendingDelivery(id)) { this.textContent = '🕐'; this.classList.remove('read'); this.classList.add('pending'); }
      else { this.textContent = '✓'; this.classList.remove('read', 'pending'); }
    }
  }
  customElements.define('qu-msg-tick', QuMsgTickElement);

  /**
   * Deutlich lesbares Badge zusätzlich zum kleinen Uhr-Symbol oben — NUR
   * bei Nachrichten mit Anhang: genau dort ist "noch nicht beim Relay
   * bestätigt" die eine Information, die vor dem Ausschalten des Geräts
   * wirklich zählt (ein reiner Text repliziert praktisch sofort, ein
   * großer Video-Anhang kann eine Weile brauchen). Selbst-abonnierend wie
   * <qu-msg-tick> oben.
   */
  class QuSyncBadgeElement extends HTMLElement {
    connectedCallback() {
      this.className = 'sync-badge';
      this._onChange = (e) => { if (e.detail.roomId === this.dataset.roomId) this.render(); };
      tickBus.addEventListener('tick-change', this._onChange);
      this.render();
    }
    disconnectedCallback() {
      tickBus.removeEventListener('tick-change', this._onChange);
    }
    render() {
      const pending = stillPendingDelivery(this.dataset.id);
      this.hidden = !pending;
      if (pending) this.textContent = syncBadgeText(this.dataset.id);
    }
  }
  customElements.define('qu-sync-badge', QuSyncBadgeElement);

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
      // `li` MUSS ans Dokument angehängt sein, BEVOR ein <qu-profile-card>
      // hineinkommt — Custom Elements feuern connectedCallback() erst beim
      // tatsächlichen Verbinden mit dem Dokument, nicht schon beim Anhängen
      // an ein noch loses `li`. Ein Kind, das VOR diesem Zeitpunkt manuell
      // hinzugefügt wird (z. B. der .dot unten), würde von _mount()s
      // `this.textContent = ''` beim späteren echten Connect sonst wieder
      // gelöscht.
      contactListEl.appendChild(li);
      if (isGroupRoom(r)) {
        // Eine Gruppe hat keine EINZELNE Identität (Name/Avatar sind
        // raumeigen) — dafür bleibt der manuell gebaute Avatar, wie schon
        // in renderRoomHeader().
        const avatar = el('div', 'avatar sm');
        setAvatar(avatar, r.alias, roomDisplayAvatar(r));
        avatar.appendChild(el('span', 'dot')); // renderPresence() findet/aktualisiert ihn über [data-room] .dot
        li.appendChild(avatar);
        li.appendChild(el('div', 'contact-name', r.alias));
      } else {
        // Ein DM IST genau eine Identität — <qu-profile-card> (siehe
        // renderRoomHeader()) übernimmt Avatar UND Alias komplett live,
        // kein aliasFor()/avatarFor()-Nachladeweg mehr nötig. `display:
        // contents` (style.css) lässt Avatar-Bild und Alias-Text direkt
        // ins Grid-Layout dieser Zeile durch, statt in einer eigenen Box
        // zu stecken.
        const card = document.createElement('qu-profile-card');
        card.setAttribute('fp', r.members[0]);
        card.qu = qu;
        li.appendChild(card); // li ist schon verbunden — connectedCallback()/_mount() laufen HIER, synchron
        card.appendChild(el('span', 'dot')); // renderPresence() findet/aktualisiert ihn über [data-room] .dot
      }
      li.appendChild(el('div', 'contact-time', r.lastTs ? fmtTime(r.lastTs) : ''));
      const previewRow = el('div', 'contact-preview');
      const previewText = r.lastTs ? `${r.lastMine ? 'Du: ' : ''}${r.lastPreview ?? ''}` : 'Noch keine Nachrichten';
      previewRow.appendChild(el('div', 'contact-last', previewText));
      if (r.unread) previewRow.appendChild(el('div', 'contact-unread', String(r.unread)));
      li.appendChild(previewRow);

      li.addEventListener('click', () => navigate(r.id));
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

  /**
   * Baut sofort/synchron nur den Platzhalter (`wrap`) und gibt ihn direkt
   * zurück — der eigentliche Aufbau (Manifest abwarten, dann Anhang selbst)
   * läuft asynchron im Hintergrund und füllt dieselbe `wrap`-Node später.
   * Genau das erlaubt buildMessageItem()/appendLiveMessage() weiterhin
   * `await renderAttachment(refId)` zu schreiben, ohne dass das komplette
   * Rendern der Nachrichtenliste auf einen unter Umständen mehrere Sekunden
   * dauernden Manifest-Sync warten müsste.
   */
  async function renderAttachment(refId) {
    const wrap = el('div', 'attachment');
    const status = el('div', 'attachment-progress', 'wird geladen …');
    wrap.appendChild(status);
    waitForManifestThenRender(refId, wrap, status);
    return wrap;
  }

  /**
   * Der Anhangs-Verweis (`refId`) und die Nachricht, die ihn trägt, sind
   * ZWEI unabhängige QuBits — eine Live-Zustellung kann die Nachricht
   * liefern, bevor ihr Manifest lokal angekommen ist (der Sender
   * veröffentlicht zwar immer erst das Manifest, dann die Nachricht, aber
   * die NETZWERK-Zustellung beider ist unabhängig, keine garantierte
   * Reihenfolge). Ein einmaliges `qu.get(refId) === null` ist also meist
   * ein VORÜBERGEHENDER Zustand ("noch nicht angekommen"), kein
   * dauerhaftes "existiert nicht" — mit Backoff mehrfach erneut versuchen,
   * statt sofort aufzugeben und dauerhaft "Anhang nicht gefunden"
   * anzuzeigen (der eigentliche Bug: ein reiner Zeitpunkt-Schnappschuss,
   * der nie erneut gerendert wurde, selbst wenn das Manifest kurz danach
   * doch noch ankam). Gibt bei endgültigem Fehlschlag einen "Erneut
   * versuchen"-Button statt einer Sackgasse.
   */
  async function waitForManifestThenRender(refId, wrap, status) {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const manifestQ = await qu.get(refId);
      if (manifestQ) { await renderAttachmentBody(refId, manifestQ, wrap, status); return; }
      // Erst NACH dem ersten await prüfbar (renderAttachment() hat `wrap`
      // bis hierhin noch gar nicht an den Aufrufer zurückgegeben, geschweige
      // denn dieser es schon ins DOM gehängt — ein Check VOR dem ersten
      // await würde hier fälschlich immer "nicht verbunden" sehen).
      if (!wrap.isConnected) return; // Nachricht/Raum inzwischen verlassen — nichts mehr zu tun
      status.textContent = `Anhang wird synchronisiert … (${attempt}/8)`;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    if (!wrap.isConnected) return;
    wrap.textContent = '';
    wrap.appendChild(el('div', 'attachment-progress', 'Anhang noch nicht verfügbar — der Absender synchronisiert möglicherweise noch.'));
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'attachment-btn';
    retry.textContent = 'Erneut versuchen';
    retry.addEventListener('click', () => {
      wrap.textContent = '';
      const newStatus = el('div', 'attachment-progress', 'wird geladen …');
      wrap.appendChild(newStatus);
      waitForManifestThenRender(refId, wrap, newStatus);
    });
    wrap.appendChild(retry);
  }

  /** Der eigentliche Anhang-Aufbau, sobald das Manifest lokal feststeht — befüllt die von renderAttachment() bereits ins DOM gehängte `wrap`-Node, statt eine neue zurückzugeben (die alte hat der Aufrufer schon angehängt). */
  async function renderAttachmentBody(refId, manifestQ, wrap, status) {
    const manifest = manifestQ.value;
    wrap.textContent = '';
    wrap.appendChild(status);

    // name/mime/size stehen bei einem verschlüsselten Anhang NICHT direkt
    // im Manifest (siehe data/files/manifest.js's metaEncryption) — readFileMeta()
    // entschlüsselt sie separat vom eigentlichen Dateiinhalt, damit Vorschau/
    // Download-Link auch VOR dem vollständigen Herunterladen möglich sind.
    const fileMeta = await readFileMeta(manifest, qu.identity);
    if (!fileMeta) {
      wrap.textContent = '';
      wrap.appendChild(el('div', 'attachment-progress', 'Anhang nicht zugänglich (nicht für dich verschlüsselt).'));
      return;
    }
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
      let holdingWakeLock = false;
      try {
        let complete = await fileTransfer.hasComplete(refId);
        if (!complete) {
          // Nur ab hier wach halten — bereits vollständig lokal vorhandene
          // Anhänge (eigener Versand, früher schon geladen) brauchen keinen
          // Download, für die lohnt sich kein Wake Lock.
          holdingWakeLock = true;
          await beginTransfer();
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
          // Ein per 🎤-Recorder gesendeter Anhang soll nicht wie ein
          // beliebiger Audio-Anhang (z. B. ein verschickter Song) aussehen
          // — erkennbar an dessen Dateinamens-Konvention (s.
          // isVoiceMessageFilename() in chat-lib.mjs), bekommt er ein
          // eigenes Label VOR dem Player statt nur dem nackten
          // <audio controls>, das für sich genommen keinen Kontext trägt.
          if (isVoiceMessageFilename(fileMeta.name)) wrap.appendChild(el('div', 'voice-message-label', '🎙️ Sprachnachricht'));
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
      } finally {
        if (holdingWakeLock) endTransfer();
      }
    }

    /** Platzhalter statt eines automatischen Downloads — Dateiname/-typ/-größe kommen aus fileMeta, das schon VOR jedem Byte-Download verfügbar ist (s. o.), ein Klick löst den eigentlichen reveal() erst aus. */
    function showLoadPlaceholder() {
      wrap.textContent = '';
      const isVoice = kind === 'audio' && isVoiceMessageFilename(fileMeta.name);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'attachment-file attachment-load-btn';
      btn.appendChild(el('span', 'file-ic', isVoice ? '🎙️' : kind === 'image' ? '🖼️' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📄'));
      const metaEl = el('div');
      metaEl.appendChild(el('div', '', isVoice ? 'Sprachnachricht' : fileMeta.name));
      metaEl.appendChild(el('div', 'file-meta', `${fileMeta.mime} · ${fmtBytes(fileMeta.size ?? 0)} · zum Laden tippen`));
      btn.appendChild(metaEl);
      btn.addEventListener('click', () => {
        wrap.textContent = '';
        status = el('div', 'attachment-progress', 'wird geladen …');
        wrap.appendChild(status);
        reveal();
      });
      wrap.appendChild(btn);
    }

    // Schon vollständig lokal vorhanden (eigener Versand, oder früher schon
    // heruntergeladen) — dann gibt es nichts zu sparen, immer sofort
    // anzeigen, unabhängig von der Einstellung. Nur ein WIRKLICH noch
    // ausstehender Download wird gegen "Medien automatisch laden" geprüft.
    if ((await fileTransfer.hasComplete(refId)) || (await autoLoadMedia())) reveal();
    else showLoadPlaceholder();
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

  /**
   * Erkannte Standort-Links (parseLocationFromUrl(), s. chat-lib.mjs)
   * bekommen einen Kartenausschnitt + "📍 Standort" + Koordinaten statt der
   * generischen Hostname/URL-Chip-Vorschau — die Info "das ist ein Ort"
   * muss auch OHNE das Bild ankommen (Offline/Tile-Server nicht erreichbar
   * etc.), daher bleiben Label+Koordinaten als Text in JEDEM Fall sichtbar,
   * das Bild ist nur eine ZUSÄTZLICHE visuelle Vorschau (entfernt sich bei
   * einem Ladefehler einfach selbst, statt eines kaputten img-Icons).
   */
  function buildLinkPreview(text) {
    const link = linkify(text).find((s) => s.type === 'link');
    if (!link) return null;
    const loc = parseLocationFromUrl(link.value);
    const a = document.createElement('a');
    a.className = loc ? 'msg-link msg-location' : 'msg-link';
    a.href = link.value;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (loc) {
      const img = document.createElement('img');
      img.className = 'msg-location-thumb';
      img.src = staticMapTileUrl(loc.lat, loc.lng);
      img.alt = 'Kartenausschnitt';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      a.appendChild(img);
      const info = el('div', 'msg-location-info');
      info.appendChild(el('div', 'link-host', '📍 Standort'));
      info.appendChild(el('div', 'msg-location-coords', `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`));
      a.appendChild(info);
    } else {
      const host = el('div', 'link-host', `🔗 ${link.hostname}`);
      a.appendChild(host);
      a.appendChild(el('div', 'link-url', link.value));
    }
    return a;
  }

  /** "Du" für die eigene Identität, sonst der bekannte Alias/Kurz-Fingerprint — dieselbe Konvention wie renderRoomList()s "Du: <Vorschau>". */
  function authorNameFor(fp) {
    return fp === qu.fingerprint ? 'Du' : (contactByFp(fp)?.alias ?? shortFp(fp));
  }

  /**
   * Der zitierte Ausschnitt einer ANDEREN Nachricht oben in der Bubble
   * (q.value.replyTo, s. dessen Doku in chat.js) — Autor+Zeitpunkt+Text
   * kommen als beim Antworten gespeicherter SCHNAPPSCHUSS, nicht per
   * Nachschlagen der Originalnachricht (die könnte lokal längst nicht
   * mehr geladen/verfügbar sein). Ein Klick springt trotzdem zum
   * Original, sofern es in der GERADE geladenen Historie steht.
   */
  function buildReplyQuote(replyTo) {
    const quote = el('div', 'msg-quote');
    quote.appendChild(el('div', 'msg-quote-author', authorNameFor(replyTo.writer)));
    quote.appendChild(el('div', 'msg-quote-time', `${fmtDayLabel(replyTo.ts)} · ${fmtTime(replyTo.ts)}`));
    if (replyTo.text) quote.appendChild(el('div', 'msg-quote-text', replyTo.text));
    quote.addEventListener('click', (ev) => { ev.stopPropagation(); scrollToMessage(replyTo.id); });
    return quote;
  }

  /**
   * Löst eine mögliche Bearbeitung auf — sucht in `list` (derselbe Raum,
   * bereits chronologisch sortiert) nach dem NEUESTEN Eintrag mit
   * `value.editOf === q.id`, dessen verifizierter `writer` MIT dem der
   * Originalnachricht übereinstimmt (jeder Schreibberechtigte des Raums
   * KÖNNTE technisch ein solches QuBit veröffentlichen, s. chat.js's
   * sendMessage()-Doku zu `editOf` — nur ein Treffer vom selben Schreiber
   * gilt als echte Bearbeitung, alles andere wird schlicht ignoriert).
   * `{ text, edited }` — `text` ist entweder der bearbeitete oder (ohne
   * Treffer) der ursprüngliche Text.
   */
  function resolveMessageText(list, q) {
    let latest = null;
    for (const other of list) {
      if (other.value?.editOf === q.id && other.writer === q.writer && (!latest || other.ts > latest.ts)) latest = other;
    }
    return latest ? { text: latest.value.text ?? '', edited: true } : { text: q.value?.text ?? '', edited: false };
  }

  /** ⋮-Button in der Kopfzeile (buildMessageHeader()) — öffnet das gemeinsame Aktionsmenü (openMessageActionsMenu() unten) für GENAU diese Nachricht. */
  function buildMessageActionsBtn(q, roomId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-actions-btn';
    btn.title = 'Weitere Optionen';
    btn.textContent = '⋮';
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); openMessageActionsMenu(q, roomId, btn); });
    return btn;
  }

  /** Kopfzeile über der Bubble: Absender (Link ins volle Profil in examples/people) links, ⋮-Aktionsmenü rechts — für JEDE Nachricht, nicht nur in Gruppen (konsistente Optik, "Du" bei eigenen Nachrichten). */
  function buildMessageHeader(q, roomId) {
    const header = el('div', 'msg-header');
    const authorLink = document.createElement('a');
    authorLink.className = 'msg-author';
    authorLink.href = `../people/index.html#/${encodeURIComponent(q.writer)}`;
    authorLink.target = '_blank';
    authorLink.rel = 'noopener';
    authorLink.textContent = authorNameFor(q.writer);
    authorLink.addEventListener('click', (ev) => ev.stopPropagation());
    header.appendChild(authorLink);
    header.appendChild(buildMessageActionsBtn(q, roomId));
    return header;
  }

  /**
   * Uhrzeit (optional + Datum, s. showDateInMessages()-Einstellung) als
   * klickbarer Anker-Link auf GENAU diese Nachricht (`/<roomId>/msg/<id>`,
   * dieselbe Route wie ein geteilter Direktlink/ein Suchtreffer) — ein
   * Klick "holt die Nachricht nach oben": renderRoute() öffnet den Chat
   * (hier schon offen, also ein No-Op) und scrollToMessage() springt an
   * den Anfang der Liste (s. dessen aktualisierte block: 'start'-Doku),
   * mit kurzem Hervorheben.
   */
  function buildMessageTimeLink(q, roomId, showDate) {
    const a = document.createElement('a');
    a.className = 'msg-time';
    a.href = buildPath(roomId, 'msg', q.id);
    a.textContent = showDate ? `${fmtDayLabel(q.ts)}, ${fmtTime(q.ts)}` : fmtTime(q.ts);
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      navigate(roomId, 'msg', q.id);
    });
    return a;
  }

  /**
   * Uhrzeit/Datum-Link + "bearbeitet"-Marker + Häkchen, als EIN Bündel —
   * wird entweder als letztes Kind DIREKT in den Textfluss von .msg-text
   * eingehängt (float: right, klassischer Messenger-Trick: der Text davor
   * bricht um dieses Element herum, landet unten rechts INNERHALB der
   * Bubble statt in einer eigenen Zeile außerhalb) oder — wenn es keinen
   * Text gibt, dem Text also nichts zum Umbrechen bliebe (reiner Anhang,
   * reiner Standort-Link) — als eigene rechtsbündige Zeile am Ende der
   * Bubble (buildMessageItem() unten entscheidet das).
   */
  function buildMessageMetaInline(q, roomId, showDate, edited, mine) {
    const span = el('span', 'msg-time-row');
    if (edited) span.appendChild(el('span', 'msg-edited', '✏️ bearbeitet '));
    span.appendChild(buildMessageTimeLink(q, roomId, showDate));
    if (mine) {
      const tick = document.createElement('qu-msg-tick');
      tick.dataset.id = q.id;
      tick.dataset.ts = q.ts;
      tick.dataset.roomId = roomId;
      span.appendChild(tick);
    }
    return span;
  }

  /**
   * Baut genau ein `<li class="msg">` — geteilt zwischen dem vollständigen
   * Neuaufbau (renderMessageList()) und dem Anhängen einer einzelnen neuen
   * Live-Nachricht (appendLiveMessage()), damit beide garantiert dasselbe
   * Markup erzeugen. `list` (derselbe Raum, für resolveMessageText() — s.
   * dessen Doku für eine mögliche Bearbeitung) und `showDate` (die
   * "Datum anzeigen"-Einstellung, EINMAL pro Render-Durchgang gelesen statt
   * pro Nachricht) explizit vom Aufrufer übergeben — beide kennen sie
   * ohnehin schon.
   */
  async function buildMessageItem(q, roomId, list, showDate) {
    const mine = q.writer === qu.fingerprint;
    const li = el('li', `msg${mine ? ' mine' : ''}`);
    li.dataset.ts = q.ts;
    li.dataset.id = q.id;
    li.appendChild(buildMessageHeader(q, roomId));
    const bubble = el('div', 'msg-bubble');
    if (q.value?.replyTo) bubble.appendChild(buildReplyQuote(q.value.replyTo));
    const { text: displayText, edited } = resolveMessageText(list, q);
    let metaInsertedInline = false;
    if (displayText) {
      // Ein Text, der NUR aus einem einzelnen Link besteht (z. B. genau
      // das, was der 📍-Standort-Button verschickt), bräuchte sonst die
      // URL zweimal — einmal als klickbaren Rohtext hier, direkt darunter
      // nochmal identisch in der Vorschau-Karte. Bei "Text + Link" (eine
      // eigene Bildunterschrift o. Ä.) bleibt der Text dagegen sichtbar —
      // nur der Sonderfall "Nachricht ist der Link" ist echte Dopplung.
      const segs = linkify(displayText);
      const isBareLink = segs.length === 1 && segs[0].type === 'link';
      if (!isBareLink) {
        const textEl = el('div', 'msg-text');
        renderMessageText(textEl, displayText);
        textEl.appendChild(buildMessageMetaInline(q, roomId, showDate, edited, mine));
        bubble.appendChild(textEl);
        metaInsertedInline = true;
      }
      const preview = buildLinkPreview(displayText);
      if (preview) bubble.appendChild(preview);
    }
    for (const refId of q.refs ?? []) {
      bubble.appendChild(await renderAttachment(refId));
    }
    if (mine && q.refs?.length) {
      // <qu-sync-badge> zieht sich seinen Anfangs- UND jeden Folgezustand
      // selbst (siehe dessen Doku oben) — hier nur erzeugen und den
      // Nachrichten-/Raumbezug mitgeben.
      const badge = document.createElement('qu-sync-badge');
      badge.dataset.id = q.id;
      badge.dataset.roomId = roomId;
      bubble.appendChild(badge);
    }
    if (!metaInsertedInline) {
      const metaRow = el('div', 'msg-meta-row');
      metaRow.appendChild(buildMessageMetaInline(q, roomId, showDate, edited, mine));
      bubble.appendChild(metaRow);
    }
    li.appendChild(bubble);
    return li;
  }

  let lastRenderedDay = null; // von renderMessageList() (Neuaufbau) UND appendLiveMessage() (einzelne neue Nachricht) gemeinsam gepflegter Tages-Trenner-Zustand der aktuell angezeigten Liste

  /**
   * `scrollToId`: springt (mit demselben Hervorheben wie scrollToMessage())
   * zu GENAU dieser Nachricht statt ans Ende — showChatScreen() übergibt
   * hier die erste noch ungelesene Nachricht (aus dem VOR dem Öffnen
   * gelesenen `unread`-Zähler, bevor der auf 0 zurückgesetzt wird), damit
   * ein Chat mit langer ungelesener Historie nicht direkt bei der
   * neuesten (und damit ggf. mittendrin übersprungenen) Nachricht landet.
   * `undefined`/keine Übereinstimmung in der Liste (z. B. `unread` war
   * größer als die tatsächlich geladene Historie) fällt auf das bisherige
   * Verhalten zurück: ans Ende (neueste Nachricht).
   */
  async function renderMessageList(roomId, scrollToId) {
    messageListEl.textContent = '';
    lastRenderedDay = null;
    const list = messagesByRoom.get(roomId) ?? [];
    const showDate = await showDateInMessages();
    let scrollTargetLi = null;
    for (const q of list) {
      if (q.value?.editOf) continue; // eine Bearbeitung ist keine eigene Bubble, s. resolveMessageText()
      const dayLabel = fmtDayLabel(q.ts);
      if (dayLabel !== lastRenderedDay) { messageListEl.appendChild(el('li', 'day-sep', dayLabel)); lastRenderedDay = dayLabel; }
      const li = await buildMessageItem(q, roomId, list, showDate);
      messageListEl.appendChild(li);
      if (scrollToId && q.id === scrollToId) scrollTargetLi = li;
    }
    if (scrollTargetLi) {
      // 'start' statt 'center' — die ausgewählte Nachricht soll direkt
      // unter der Kopfzeile erscheinen, nicht in der Mitte der Liste.
      scrollTargetLi.scrollIntoView({ block: 'start' });
      scrollTargetLi.querySelector('.msg-bubble')?.classList.add('jump-highlight');
    } else {
      // Ein frisch geöffneter Chat ohne (auffindbares) ungelesenes Ziel
      // startet unten (neueste Nachricht), unabhängig vom bisherigen
      // Scroll-Zustand — anders als appendLiveMessage() unten, das das
      // bewusst NUR tut, wenn man schon dort war.
      messageListEl.scrollTop = messageListEl.scrollHeight;
    }
  }

  /** Hängt EINE neu eingetroffene Live-Nachricht an, statt die komplette Liste neu aufzubauen (kein erneutes Laden/Rendern schon vorhandener Anhänge bei jeder neuen Nachricht) — folgt dem Ende nur, wenn man vorher schon dort war (isNearBottom()), reißt also niemanden aus der gerade gelesenen älteren Historie. */
  async function appendLiveMessage(q, roomId) {
    const stick = isNearBottom();
    const dayLabel = fmtDayLabel(q.ts);
    if (dayLabel !== lastRenderedDay) { messageListEl.appendChild(el('li', 'day-sep', dayLabel)); lastRenderedDay = dayLabel; }
    messageListEl.appendChild(await buildMessageItem(q, roomId, messagesByRoom.get(roomId) ?? [], await showDateInMessages()));
    if (stick) messageListEl.scrollTop = messageListEl.scrollHeight;
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
    // Eine noch offene Antwort-Vorschau gehört zu GENAU dem Raum, in dem
    // sie gestartet wurde (replyTarget.roomId, s. dessen Doku oben) — beim
    // Wechsel in einen ANDEREN Chat verworfen, sonst würde sie dort
    // fälschlich weiter angezeigt/mitgesendet.
    if (replyTarget && replyTarget.roomId !== roomId) { replyTarget = null; renderReplyPreview(); }
    if (editTarget && editTarget.roomId !== roomId) { editTarget = null; textInput.value = ''; autoGrow(); renderReplyPreview(); }
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
    // Erste ungelesene Nachricht VOR dem untenstehenden upsertRoom(unread: 0)
    // bestimmen — danach ist der Zähler weg. `unread` ist die Anzahl der
    // NEUESTEN Nachrichten seit dem letzten Lesen (s. dessen Doku bei der
    // Live-Nachrichten-Verarbeitung oben) — die erste davon ist also genau
    // `list.length - unread` in der bereits chronologisch sortierten Liste.
    // Ungültige/veraltete Zählerstände (0, "mehr als geladen") fallen
    // einfach auf `undefined` zurück -> renderMessageList() scrollt dann
    // wie bisher ans Ende (neueste Nachricht).
    const unreadCount = roomById(roomId)?.unread ?? 0;
    const list = messagesByRoom.get(roomId) ?? [];
    const firstUnreadId = unreadCount > 0 && unreadCount < list.length ? list[list.length - unreadCount].id : undefined;
    upsertRoom(roomId, { unread: 0 }); // löst renderRoomList() selbst über die zentrale rooms-Subscription aus (siehe main())
    await renderMessageList(roomId, firstUnreadId);
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
      // Dieselbe Darstellung wie im Chat selbst statt einer bloßen
      // Platzhalter-Zeile ("📎 Anhang") — buildLinkPreview()/renderAttachment()
      // sind exakt dieselben Funktionen, die auch buildMessageItem() für
      // eine echte Chat-Bubble aufruft, hier nur zusätzlich zum
      // Text-Snippet statt in einer eigenen Bubble. `stopPropagation()`
      // auf jedem eingebetteten interaktiven Ergebnis (Link öffnen,
      // Bild-Lightbox, Anhang laden) verhindert, dass so ein Klick ZUSÄTZLICH
      // noch das äußere li.onclick (Sprung zur Nachricht) auslöst — ein
      // Klick soll hier klar EINE der beiden Aktionen sein, nie beide auf
      // einmal.
      if (q.value?.text) body.appendChild(buildSnippet(q.value.text, query));
      const linkPreview = q.value?.text ? buildLinkPreview(q.value.text) : null;
      if (linkPreview) {
        linkPreview.addEventListener('click', (ev) => ev.stopPropagation());
        body.appendChild(linkPreview);
      }
      for (const refId of q.refs ?? []) {
        renderAttachment(refId).then((node) => {
          node.addEventListener('click', (ev) => ev.stopPropagation());
          body.appendChild(node);
        });
      }
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
    // 'start' statt 'center' — landet direkt unter der Kopfzeile statt in
    // der Mitte der Liste (konsistent mit renderMessageList()s Sprungziel).
    li.scrollIntoView({ block: 'start' });
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

  /** Voller, teilbarer Direktlink zu genau dieser Nachricht — dieselbe Route wie openSearchResult()/renderRoute()'s `/<roomId>/msg/<id>`, hier als absolute URL (für Zwischenablage/System-Teilen statt nur internes Navigieren). */
  function messageLink(roomId, messageId) {
    return location.origin + location.pathname + buildPath(roomId, 'msg', messageId);
  }

  // --- Antworten (Zitat) ---
  // replyTarget: { id, writer, ts, text } — ein SCHNAPPSCHUSS der Original-
  // nachricht (nicht nur ihre Id), damit buildReplyQuote() ihn auch dann
  // noch anzeigen kann, wenn das Original lokal längst nicht mehr geladen
  // ist. Wird composer.submit (unten) als `replyTo` mitgegeben und danach
  // geleert — eine "aktive Antwort" ist ausschließlich ein Zustand DIESES
  // Composers, nicht Teil der Nachricht, bevor sie abgeschickt ist.
  let replyTarget = null;
  // --- Bearbeiten ---
  // editTarget: { id, roomId, text } — die eigene Nachricht, die gerade
  // bearbeitet wird; textInput ist dabei mit ihrem aktuellen Text
  // vorausgefüllt (s. msgActionEditBtn's Handler unten). Teilt sich mit
  // replyTarget dieselbe Vorschau-Leiste (#reply-preview) — Antworten UND
  // Bearbeiten sind bewusst gegenseitig exklusive Composer-Zustände (immer
  // nur EINER von beiden aktiv, s. beide Handler unten).
  let editTarget = null;
  function renderReplyPreview() {
    if (editTarget) {
      replyPreviewEl.hidden = false;
      replyPreviewAuthorEl.textContent = '✏️ Nachricht bearbeiten';
      replyPreviewTextEl.textContent = editTarget.text;
      return;
    }
    replyPreviewEl.hidden = !replyTarget;
    if (!replyTarget) return;
    replyPreviewAuthorEl.textContent = authorNameFor(replyTarget.writer);
    replyPreviewTextEl.textContent = replyTarget.text || '📎 Anhang';
  }
  replyCancelBtn.addEventListener('click', () => {
    // Eine abgebrochene Bearbeitung räumt auch den vorausgefüllten Text
    // wieder weg — anders als bei "Antworten abbrechen", wo der Composer-
    // Text unabhängig vom Zitat war (der User hat ihn selbst getippt, der
    // bleibt beim Abbrechen stehen).
    if (editTarget) { textInput.value = ''; autoGrow(); }
    replyTarget = null;
    editTarget = null;
    renderReplyPreview();
  });

  // --- Aktionsmenü einer Nachricht (⋮ in der Kopfzeile, s. buildMessageActionsBtn()) ---
  let messageActionsContext = null; // { q, roomId } für die Nachricht, deren Menü gerade offen ist
  function openMessageActionsMenu(q, roomId, btn) {
    messageActionsContext = { q, roomId };
    const rect = btn.getBoundingClientRect();
    // "Teilen" nur, wenn es die Web Share API überhaupt gibt — sonst ein
    // Knopf, der bei jedem Klick sichtbar nichts täte.
    msgActionShareBtn.hidden = !navigator.share;
    // Weiterleiten braucht Text (s. msgActionForwardBtn's eigene Doku
    // weiter unten — Anhänge werden bewusst nicht mit übernommen) — bei
    // einer reinen Anhang-Nachricht ohne Text gäbe es sonst einen Knopf,
    // der wirkungslos bliebe statt einfach gar nicht erst dazustehen.
    msgActionForwardBtn.hidden = !q.value?.text;
    // Bearbeiten nur für EIGENE Textnachrichten, die selbst noch keine
    // Bearbeitung SIND (q.value.editOf) — eine Bearbeitung bekommt nie ihr
    // eigenes Aktionsmenü angezeigt, da sie nie als eigene Bubble
    // gerendert wird (s. renderMessageList()'s Filter).
    msgActionEditBtn.hidden = !(q.writer === qu.fingerprint && q.value?.text && !q.value?.editOf);
    messageActionsMenuEl.hidden = false;
    // ERST einblenden, DANN messen (offsetHeight bei hidden wäre 0) — an
    // den unteren/rechten Rand andocken statt über den sichtbaren Bereich
    // hinauszuragen, falls der Button nahe am Rand sitzt (z. B. die
    // jeweils erste/letzte Nachricht in einem kurzen Chat-Fenster).
    const menuRect = messageActionsMenuEl.getBoundingClientRect();
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight) top = Math.max(4, rect.top - menuRect.height - 4);
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth) left = window.innerWidth - menuRect.width - 4;
    messageActionsMenuEl.style.top = `${top}px`;
    messageActionsMenuEl.style.left = `${Math.max(4, left)}px`;
  }
  function closeMessageActionsMenu() {
    messageActionsMenuEl.hidden = true;
    messageActionsContext = null;
  }
  document.addEventListener('click', (ev) => {
    if (!messageActionsMenuEl.hidden && !messageActionsMenuEl.contains(ev.target) && !ev.target.closest('.msg-actions-btn')) {
      closeMessageActionsMenu();
    }
  });

  msgActionReplyBtn.addEventListener('click', () => {
    const { q, roomId } = messageActionsContext;
    closeMessageActionsMenu();
    editTarget = null;
    const { text } = resolveMessageText(messagesByRoom.get(roomId) ?? [], q); // zitiert die evtl. bearbeitete, aktuell sichtbare Fassung
    replyTarget = { id: q.id, writer: q.writer, ts: q.ts, text, roomId };
    renderReplyPreview();
    textInput.focus();
  });

  msgActionEditBtn.addEventListener('click', () => {
    const { q, roomId } = messageActionsContext;
    closeMessageActionsMenu();
    replyTarget = null;
    const { text } = resolveMessageText(messagesByRoom.get(roomId) ?? [], q);
    editTarget = { id: q.id, roomId, text };
    textInput.value = text;
    autoGrow();
    renderReplyPreview();
    textInput.focus();
  });

  msgActionCopyBtn.addEventListener('click', async () => {
    const { q } = messageActionsContext;
    closeMessageActionsMenu();
    if (q.value?.text) await navigator.clipboard.writeText(q.value.text).catch(() => {});
  });

  msgActionCopyLinkBtn.addEventListener('click', async () => {
    const { q, roomId } = messageActionsContext;
    closeMessageActionsMenu();
    await navigator.clipboard.writeText(messageLink(roomId, q.id)).catch(() => {});
    statusBar.textContent = 'Link kopiert.';
    setTimeout(() => { if (statusBar.textContent === 'Link kopiert.') statusBar.textContent = 'Verbunden'; }, 2000);
  });

  msgActionShareBtn.addEventListener('click', async () => {
    const { q, roomId } = messageActionsContext;
    closeMessageActionsMenu();
    if (!navigator.share) return;
    try {
      await navigator.share({ text: q.value?.text || undefined, url: messageLink(roomId, q.id) });
    } catch { /* Nutzer hat den System-Teilen-Dialog abgebrochen — kein Fehler */ }
  });

  /**
   * Weiterleiten — öffnet DASSELBE Zielauswahl-Modal wie ein externer
   * "Teilen an QU Chat"-Share (share-target-modal/pendingShare/
   * applyShareToRoom(), s. dort), nur AD-HOC statt über den Router
   * (shareTargetIsRouted = false, s. closeShareTargetModal()) — dieselbe
   * Chat-Auswahl + Composer-Übernahme, ohne den Umweg über
   * Service-Worker/Cache, der nur für einen ECHTEN externen Share nötig
   * ist. Anhänge werden dabei bewusst NICHT mit weitergeleitet (bräuchte
   * ein erneutes Herunterladen+Entschlüsseln+Hochladen der Originaldatei
   * — als klar kommunizierte Einschränkung einfacher als eine
   * halbfertige/unzuverlässige Variante).
   */
  msgActionForwardBtn.addEventListener('click', () => {
    const { q } = messageActionsContext;
    closeMessageActionsMenu();
    if (!q.value?.text) return; // keine reine Anhang-Nachricht ohne Text weiterleitbar, s. o.
    shareTargetIsRouted = false;
    pendingShare = { text: q.value.text, url: '', title: '', files: [] };
    shareTargetSummaryEl.textContent = q.refs?.length
      ? 'Nachricht weiterleiten (nur Text — Anhänge werden nicht mit übernommen)'
      : 'Nachricht weiterleiten';
    shareTargetRoomListEl.textContent = '';
    shareTargetErrorEl.textContent = '';
    shareTargetModal.hidden = false;
    renderShareTargetRoomList();
  });

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
    removeRoomEntry(roomId); // löst renderRoomList() selbst über die zentrale rooms-Subscription aus (siehe main())
    if (activeRoomId === roomId) navigate();
  }

  // --- Senden ---
  let pendingFiles = [];
  function renderPendingFiles() {
    pendingFilesEl.textContent = '';
    pendingFiles.forEach((file, i) => {
      const chip = el('div', 'pending-file');
      chip.dataset.index = i;
      const isVoice = mediaKind(file.type) === 'audio' && isVoiceMessageFilename(file.name);
      chip.appendChild(document.createTextNode(`${isVoice ? '🎙️ Sprachnachricht' : `${mediaKind(file.type) === 'image' ? '🖼️' : mediaKind(file.type) === 'video' ? '🎬' : mediaKind(file.type) === 'audio' ? '🎵' : '📎'} ${file.name}`}`));
      // Leer/versteckt, solange nicht gesendet wird — setPendingFileProgress()
      // (composer-Submit-Handler unten) füllt sie WÄHREND des lokalen
      // Verschlüsselns/Zerstückelns eines großen Anhangs (z. B. Video), damit
      // das nicht wie ein hängender Sendevorgang aussieht — direkt an DIESEM
      // Datei-Chip, nicht nur als knappe, leicht übersehene Statuszeile oben.
      chip.appendChild(el('div', 'pending-file-progress'));
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

  // --- Standort teilen — kein eigener Nachrichtentyp: der Kartenlink geht
  // als ganz normaler Text raus, die bereits vorhandene Link-Vorschau
  // (buildLinkPreview() oben) übernimmt Darstellung/Anklickbarkeit von
  // allein. Anbieter (OSM/Google/Apple/eigene URL) kommt aus den
  // App-Einstellungen (mapProvider(), s. o.).
  locationBtn.addEventListener('click', () => {
    if (!activeRoomId) return;
    if (!navigator.geolocation) { statusBar.textContent = 'Standortfreigabe wird von diesem Browser nicht unterstützt.'; return; }
    locationBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        locationBtn.disabled = false;
        const { latitude, longitude } = pos.coords;
        const provider = await mapProvider();
        const template = provider === 'custom' ? await mapCustomUrlTemplate() : '';
        const url = buildLocationUrl(provider, latitude, longitude, template);
        textInput.value = textInput.value ? `${textInput.value} ${url}` : url;
        autoGrow();
        composer.requestSubmit();
      },
      (err) => {
        locationBtn.disabled = false;
        statusBar.textContent = err.code === err.PERMISSION_DENIED
          ? 'Zugriff auf den Standort verweigert.'
          : 'Standort konnte nicht ermittelt werden.';
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });

  // --- Sprachnachricht — Aufnehmen -> Abhören -> Verwerfen ODER Senden.
  // Läuft, sobald gesendet wird, über exakt denselben Anhang-Pfad wie ein
  // per 📎 gewählter Datei-Anhang (pendingFiles -> composer-Submit-Handler
  // oben) — kein eigener Nachrichtentyp, keine eigene Verschlüsselungs-/
  // Fortschrittslogik nötig; Wiedergabe im Chat übernimmt bereits
  // renderAttachmentBody()'s audio-Zweig.
  let mediaRecorder = null;
  let recordedChunks = [];
  let recordingStream = null;
  // Aufsummierte Dauer VOR dem aktuell laufenden Recording-Segment (0, oder
  // > 0 nach einer/mehreren Pausen) — die tatsächlich verstrichene Zeit ist
  // das PLUS die Zeit seit recordingSegmentStartedAt, solange gerade
  // aufgenommen wird (currentElapsedMs() unten). Getrennt von einer
  // einzelnen laufenden Uhr, weil Pause/Fortsetzen sonst entweder die
  // gesamte bisherige Dauer verwirft oder während der Pause weiterzählt.
  let recordingElapsedMs = 0;
  let recordingSegmentStartedAt = 0;
  let recordingTimerInterval = null;
  let recordedBlob = null;
  let recordedUrl = null;
  let discardOnStop = false;
  // 'idle' | 'armed' (Mikrofon frei, noch nichts aufgenommen) | 'recording'
  // | 'paused' | 'preview' — s. setVoiceRecorderState().
  let voiceRecorderState = 'idle';

  function fmtRecTimer(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function currentElapsedMs() {
    return recordingElapsedMs + (voiceRecorderState === 'recording' ? Date.now() - recordingSegmentStartedAt : 0);
  }
  function updateVoiceTimerDisplay() { voiceTimerEl.textContent = fmtRecTimer(currentElapsedMs()); }

  /**
   * Zentrale Zustandsanzeige für den gesamten Recorder — jede Aktion
   * (Start/Pause/Fortsetzen/Stop/Verwerfen/Senden) ruft NUR das hier auf,
   * statt selbst einzelne `hidden`-Flags zu setzen; verhindert, dass ein
   * Zustand (z. B. "Vorhören" UND "Aufnahme läuft" gleichzeitig sichtbar)
   * an einer der mehreren Aufrufstellen vergessen wird. Pause/Fortsetzen
   * nur sichtbar, wenn der Browser MediaRecorder#pause() überhaupt anbietet
   * (Safari-Versionen vor 14.5 nicht) — sonst bleibt nur Start+Stop, exakt
   * wie ein Recorder ohne Pause-Fähigkeit aussehen sollte, statt eines
   * wirkungslosen Knopfs.
   */
  function setVoiceRecorderState(state) {
    voiceRecorderState = state;
    const canPause = typeof mediaRecorder?.pause === 'function';
    voiceRecorderEl.hidden = state === 'idle';
    composer.hidden = state !== 'idle';
    voiceDiscardBtn.hidden = state === 'idle';
    voiceStatusEl.hidden = state === 'preview';
    voicePreviewAudio.hidden = state !== 'preview';
    voiceStartBtn.hidden = state !== 'armed';
    voicePauseBtn.hidden = !(state === 'recording' && canPause);
    voiceResumeBtn.hidden = state !== 'paused';
    voiceStopBtn.hidden = !(state === 'recording' || state === 'paused');
    voiceSendBtn.hidden = state !== 'preview';
    voiceStatusEl.classList.toggle('recording', state === 'recording');
    voiceStatusEl.classList.toggle('paused', state === 'paused');
    updateVoiceTimerDisplay();
  }

  function resetVoiceRecorder() {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
    if (recordedUrl) { URL.revokeObjectURL(recordedUrl); recordedUrl = null; }
    recordedBlob = null;
    recordedChunks = [];
    recordingElapsedMs = 0;
    stopStream(recordingStream);
    recordingStream = null;
    mediaRecorder = null;
    discardOnStop = false;
    voicePreviewAudio.src = '';
    setVoiceRecorderState('idle');
  }

  /**
   * 🎤 fragt NUR das Mikrofon an und versetzt den Recorder in "armed" —
   * die eigentliche Aufnahme beginnt erst mit einem bewussten Tipp auf
   * Start (voiceStartBtn unten), damit die ersten Sekunden nach dem Antippen
   * nicht überraschend unaufgenommen bleiben (vorher startete MediaRecorder
   * hier sofort automatisch mit).
   */
  voiceBtn.addEventListener('click', async () => {
    if (!activeRoomId) return;
    if (typeof MediaRecorder === 'undefined') { statusBar.textContent = 'Sprachnachrichten werden von diesem Browser nicht unterstützt.'; return; }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      statusBar.textContent = mediaErrorMessage(e);
      return;
    }
    recordingStream = stream;
    recordedChunks = [];
    recordingElapsedMs = 0;
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener('dataavailable', (ev) => { if (ev.data.size) recordedChunks.push(ev.data); });
    mediaRecorder.addEventListener('stop', () => {
      stopStream(recordingStream);
      recordingStream = null;
      clearInterval(recordingTimerInterval);
      if (discardOnStop) { resetVoiceRecorder(); return; }
      recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      recordedUrl = URL.createObjectURL(recordedBlob);
      voicePreviewAudio.src = recordedUrl;
      setVoiceRecorderState('preview');
    });
    setVoiceRecorderState('armed');
  });

  voiceStartBtn.addEventListener('click', () => {
    if (!mediaRecorder || mediaRecorder.state !== 'inactive') return;
    mediaRecorder.start();
    recordingSegmentStartedAt = Date.now();
    setVoiceRecorderState('recording');
    recordingTimerInterval = setInterval(updateVoiceTimerDisplay, 250);
  });

  voicePauseBtn.addEventListener('click', () => {
    if (mediaRecorder?.state !== 'recording') return;
    mediaRecorder.pause();
    recordingElapsedMs += Date.now() - recordingSegmentStartedAt;
    clearInterval(recordingTimerInterval);
    setVoiceRecorderState('paused');
  });

  voiceResumeBtn.addEventListener('click', () => {
    if (mediaRecorder?.state !== 'paused') return;
    mediaRecorder.resume();
    recordingSegmentStartedAt = Date.now();
    setVoiceRecorderState('recording');
    recordingTimerInterval = setInterval(updateVoiceTimerDisplay, 250);
  });

  voiceStopBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  });

  voiceDiscardBtn.addEventListener('click', () => {
    // "armed" (noch nie gestartet) oder "preview" (schon fertig gestoppt):
    // MediaRecorder ist bereits 'inactive', kein stop()-Event mehr nötig —
    // direkt zurücksetzen. Sonst (recording/paused) erst sauber stoppen,
    // markiert für Verwerfen statt Vorschau (s. discardOnStop im
    // 'stop'-Handler oben).
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { discardOnStop = true; mediaRecorder.stop(); }
    else resetVoiceRecorder();
  });

  voiceSendBtn.addEventListener('click', () => {
    if (!recordedBlob || !activeRoomId) return;
    const ext = (recordedBlob.type.split('/')[1] || 'webm').split(';')[0];
    const file = new File([recordedBlob], `Sprachnachricht-${Date.now()}.${ext}`, { type: recordedBlob.type });
    pendingFiles.push(file);
    resetVoiceRecorder();
    composer.requestSubmit();
  });

  composer.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!activeRoomId) return;
    const text = textInput.value.trim();
    // Bearbeiten-Modus: eigener, kleinerer Pfad statt des restlichen
    // Sende-Ablaufs unten — eine Bearbeitung trägt nie Anhänge/ein Zitat
    // (s. chat.js's sendMessage()-Doku zu `editOf`), ein leerer Text bricht
    // nichts ab (dafür gibt es "Verwerfen" in der Vorschau-Leiste), sendet
    // aber auch nichts — eine Bearbeitung zu "nichts" wäre ein Löschen,
    // das ist bewusst nicht Teil dieser Funktion.
    if (editTarget) {
      if (!text) return;
      const roomId = activeRoomId;
      const room = roomById(roomId);
      sendBtn.disabled = true;
      try {
        await qu.sendMessage(roomId, { text, encryptFor: [qu.fingerprint, ...room.members], editOf: editTarget.id });
        textInput.value = '';
        autoGrow();
        editTarget = null;
        renderReplyPreview();
      } catch (e) {
        console.error('[chat] edit failed:', e);
        statusBar.textContent = `Bearbeiten fehlgeschlagen: ${e.message}`;
        statusBar.classList.add('err');
        setTimeout(() => { statusBar.textContent = 'Verbunden'; statusBar.classList.remove('err'); }, 4000);
      } finally {
        sendBtn.disabled = false;
      }
      return;
    }
    const files = pendingFiles;
    if (!text && !files.length) return;
    const roomId = activeRoomId;
    const room = roomById(roomId);
    sendBtn.disabled = true;
    // Entfernen-Buttons der Datei-Chips während des Sendens sperren — sonst
    // könnte ein Klick währenddessen `pendingFiles` (dieselbe Referenz wie
    // `files` oben) mitten im Verschlüsseln/Zerstückeln verändern.
    for (const btn of pendingFilesEl.querySelectorAll('button')) btn.disabled = true;
    try {
      const attachments = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        attachments.push({ bytes, name: file.name, mime: file.type || 'application/octet-stream', fileStorage: localFileStorage });
      }
      // readers ist bewusst ['*'] (siehe ensureRoom()) — Vertraulichkeit
      // kommt hier ausschließlich aus dem expliziten encryptFor, nicht aus
      // einer restriktiven Space-ACL (die Default-Auto-Verschlüsselung in
      // core/session.js griffe nur bei eingeschränkten `readers`).
      // Verschlüsselung ist fest an (isRoomEncrypted(), kein Opt-out mehr,
      // s. dessen Doku) — alle Mitglieder (nicht mehr nur EIN Peer): bei
      // einem DM ist das exakt der bisherige Zwei-Empfänger-Fall, bei
      // einer Gruppe sind es entsprechend mehr.
      const sent = await qu.sendMessage(roomId, {
        text, attachments, encryptFor: [qu.fingerprint, ...room.members],
        // roomId (nur intern zum Erkennen eines Raumwechsels genutzt, s.
        // replyTarget's eigene Doku) gehört NICHT in die gespeicherte
        // Nachricht — innerhalb eines Raums ohnehin immer derselbe.
        replyTo: replyTarget ? { id: replyTarget.id, writer: replyTarget.writer, ts: replyTarget.ts, text: replyTarget.text } : undefined,
        // Fortschritt für lokales Verschlüsseln/Zerstückeln GROSSER Anhänge
        // (z. B. ein Video) — ohne das sah ein größerer Upload nach einem
        // hängenden Sendevorgang aus, weil die UI vorher bis zum Schluss
        // nichts von der Arbeit zeigte, die publishFile() dabei im
        // Hintergrund macht (Hashing/Verschlüsseln pro Chunk).
        onAttachmentProgress: attachments.length ? (i, p) => {
          const label = attachments.length > 1 ? ` (${i + 1}/${attachments.length})` : '';
          const text = p.phase === 'encrypting'
            ? `wird verschlüsselt …`
            : `wird vorbereitet … ${Math.round((p.done / p.total) * 100)}%`;
          statusBar.textContent = `Anhang${label} ${text}`;
          // Direkt am betroffenen Datei-Chip, nicht nur in der leicht zu
          // übersehenden Statuszeile oben — siehe renderPendingFiles()'
          // eigene Doku zum `.pending-file-progress`-Element.
          const chip = pendingFilesEl.querySelector(`.pending-file[data-index="${i}"] .pending-file-progress`);
          if (chip) chip.textContent = text;
        } : undefined,
      });
      statusBar.textContent = 'Verbunden';
      textInput.value = '';
      autoGrow();
      pendingFiles = [];
      renderPendingFiles();
      replyTarget = null;
      renderReplyPreview();

      // "Beim Relay angekommen?"-Status: als unbestätigt eintragen (auch
      // persistiert, siehe PENDING_DELIVERY_KEY) und im Hintergrund prüfen
      // — siehe confirmDelivery()'s eigene Doku oben für das Wie/Warum.
      const entry = { id: sent.qubit.id, ts: sent.qubit.ts, roomId, refs: sent.refs };
      pendingDeliveries.push(entry);
      savePendingDeliveries(pendingDeliveries);
      notifyTicks(roomId);
      confirmDelivery(entry).catch(() => {});
    } catch (e) {
      console.error('[chat] send failed:', e);
      statusBar.textContent = `Senden fehlgeschlagen: ${e.message}`;
      statusBar.classList.add('err');
      setTimeout(() => { statusBar.textContent = 'Verbunden'; statusBar.classList.remove('err'); }, 4000);
    } finally {
      sendBtn.disabled = false;
      // Bei einem Fehlschlag bleiben die Datei-Chips stehen (siehe catch
      // oben) — dann müssen ihre Entfernen-Buttons auch wieder nutzbar
      // sein. Bei Erfolg ist pendingFilesEl bereits leer (renderPendingFiles()
      // oben), der Query trifft dann einfach nichts.
      for (const btn of pendingFilesEl.querySelectorAll('button')) btn.disabled = false;
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
    await storage.put(ALIAS_KEY, alias);
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
  async function showAppSettingsScreen() {
    appSettingsModal.hidden = false;
    refreshPushUI();
    soundMessagesToggle.checked = await soundEnabled(SOUND_MESSAGES_KEY);
    soundCallsToggle.checked = await soundEnabled(SOUND_CALLS_KEY);
    autoLoadMediaToggle.checked = await autoLoadMedia();
    showDateToggle.checked = await showDateInMessages();
    mapProviderSelect.value = await mapProvider();
    mapCustomUrlInput.value = await mapCustomUrlTemplate();
    mapCustomUrlRow.hidden = mapProviderSelect.value !== 'custom';
    presenceSharingToggle.checked = await presenceSharingEnabled();
    shareTargetToggle.checked = await shareTargetEnabled();
  }
  settingsBtn.addEventListener('click', () => navigate('settings'));
  $('app-settings-close-btn').addEventListener('click', closeScreen);
  appSettingsModal.addEventListener('click', (ev) => { if (ev.target === appSettingsModal) closeScreen(); });
  soundMessagesToggle.addEventListener('change', () => setSoundEnabled(SOUND_MESSAGES_KEY, soundMessagesToggle.checked));
  soundCallsToggle.addEventListener('change', () => setSoundEnabled(SOUND_CALLS_KEY, soundCallsToggle.checked));
  autoLoadMediaToggle.addEventListener('change', () => setAutoLoadMedia(autoLoadMediaToggle.checked));
  // Betrifft ALLE Nachrichten des gerade offenen Chats sofort — ein
  // erneutes Öffnen des Chats wäre sonst der einzige Weg, die neue
  // Darstellung zu sehen.
  showDateToggle.addEventListener('change', async () => {
    await setShowDateInMessages(showDateToggle.checked);
    if (activeRoomId) renderMessageList(activeRoomId);
  });
  mapProviderSelect.addEventListener('change', () => {
    setMapProvider(mapProviderSelect.value);
    mapCustomUrlRow.hidden = mapProviderSelect.value !== 'custom';
  });
  mapCustomUrlInput.addEventListener('change', () => setMapCustomUrlTemplate(mapCustomUrlInput.value.trim()));
  // Wirkt sofort auf alle schon offenen Räume (ensuredRooms), nicht erst
  // nach einem Neuladen — sonst bräuchte "online teilen ausschalten" einen
  // Reload, um wirklich sofort aufzuhören zu senden.
  presenceSharingToggle.addEventListener('change', async () => {
    const enabled = presenceSharingToggle.checked;
    await setPresenceSharingEnabled(enabled);
    if (enabled) {
      for (const roomId of ensuredRooms) {
        if (!stopHeartbeatByRoom.has(roomId)) stopHeartbeatByRoom.set(roomId, qu.startHeartbeat(roomId, { intervalMs: PRESENCE_HEARTBEAT_MS }));
      }
    } else {
      for (const stop of stopHeartbeatByRoom.values()) stop();
      stopHeartbeatByRoom.clear();
    }
  });
  shareTargetToggle.addEventListener('change', () => setShareTargetEnabled(shareTargetToggle.checked));

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
      // Bewusst weiterhin direktes `localStorage` — dies ist ein "alles
      // außer X auf diesem Origin löschen"-Vorgang, nicht "meinen per
      // Adapter verwalteten Datensatz lesen/schreiben"; `storage` (der
      // LocalStorageAdapter oben) kennt nur EIGENE Keys, kein generisches
      // "alle Keys auflisten".
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

  // --- "Teilen an QU Chat" — `/share/<id>` (Router) ---
  //
  // Gegenstück zu sw.js's handleShareTarget(): der System-Teilen-Dialog
  // (Galerie, ein anderer Browser, eine andere App) landet über
  // manifest.webmanifest's share_target zuerst dort, der Service Worker
  // legt den Inhalt kurz im SHARE_CACHE_NAME-Cache ab und leitet auf genau
  // diese Route um. Hier wird er einmalig ausgelesen (und dabei aus dem
  // Cache gelöscht — kein Verbleib über diesen Moment hinaus), die
  // Nutzerin wählt EINEN Chat, danach läuft alles Weitere über den ganz
  // normalen Composer (dieselbe pendingFiles/textInput-Übernahme wie ein
  // manuell gewählter Anhang oder eingegebener Text — keine eigene
  // Versand-Logik).
  let pendingShare = null; // { text, url, title, files: File[] } zwischen showShareTargetScreen() und applyShareToRoom()

  async function loadSharePayload(id) {
    if (!('caches' in window)) return null;
    const cache = await caches.open(SHARE_CACHE_NAME);
    const metaRes = await cache.match(`/share-payload/${id}`);
    if (!metaRes) return null;
    const meta = await metaRes.json();
    await cache.delete(`/share-payload/${id}`);
    const files = [];
    for (let i = 0; i < meta.fileCount; i++) {
      const key = `/share-file/${id}/${i}`;
      const fileRes = await cache.match(key);
      if (!fileRes) continue; // einzelne Datei fehlt (z. B. vorzeitig abgebrochen) — Rest bleibt trotzdem nutzbar
      const blob = await fileRes.blob();
      files.push(new File([blob], meta.fileNames[i] || `Datei-${i + 1}`, { type: meta.fileTypes[i] || blob.type }));
      await cache.delete(key);
    }
    return { text: meta.text || '', url: meta.url || '', title: meta.title || '', files };
  }

  function renderShareTargetRoomList() {
    shareTargetRoomListEl.textContent = '';
    shareTargetErrorEl.textContent = '';
    const withNames = rooms.map((r) => ({ ...r, alias: roomDisplayName(r) }));
    const sorted = sortByActivity(withNames);
    if (!sorted.length) {
      shareTargetErrorEl.textContent = 'Noch kein Chat vorhanden — zuerst einen Chat starten, dann erneut teilen.';
      return;
    }
    for (const r of sorted) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'share-target-room-btn';
      const avatar = el('div', 'avatar sm');
      setAvatar(avatar, r.alias, roomDisplayAvatar(r));
      btn.appendChild(avatar);
      btn.appendChild(el('span', '', r.alias));
      btn.addEventListener('click', () => applyShareToRoom(r.id));
      li.appendChild(btn);
      shareTargetRoomListEl.appendChild(li);
    }
  }

  async function showShareTargetScreen(id) {
    shareTargetIsRouted = true;
    shareTargetSummaryEl.textContent = 'Lädt …';
    shareTargetRoomListEl.textContent = '';
    shareTargetErrorEl.textContent = '';
    shareTargetModal.hidden = false;
    const share = await loadSharePayload(id);
    if (!share) {
      shareTargetSummaryEl.textContent = 'Geteilter Inhalt nicht mehr verfügbar (z. B. schon verwendet oder der Tab wurde neu geladen).';
      return;
    }
    pendingShare = share;
    const parts = [];
    if (share.files.length) parts.push(`${share.files.length} Datei${share.files.length === 1 ? '' : 'en'}`);
    if (share.text || share.url) parts.push('Text/Link');
    shareTargetSummaryEl.textContent = parts.length ? `Geteilt: ${parts.join(' + ')}` : 'Kein Inhalt zum Teilen gefunden.';
    renderShareTargetRoomList();
  }

  /**
   * `/share-blocked` — sw.js's handleShareTarget() leitet HIERHIN um,
   * wenn shareTargetEnabled() zum Zeitpunkt des eingehenden Shares AUS
   * war (Einstellungen → Privatsphäre → "Teilen an QU Chat entgegennehmen").
   * Der geteilte Inhalt wurde in diesem Fall nie in einen Cache
   * geschrieben — es gibt hier also nichts auszulesen, nur eine
   * Bestätigung, dass bewusst nichts passiert ist (kein stiller
   * Fehlschlag ohne Erklärung).
   */
  function showShareBlockedScreen() {
    shareTargetIsRouted = true;
    shareTargetSummaryEl.textContent = '"Teilen an QU Chat" ist deaktiviert (Einstellungen → Privatsphäre). Es wurde nichts übernommen.';
    shareTargetRoomListEl.textContent = '';
    shareTargetErrorEl.textContent = '';
    shareTargetModal.hidden = false;
  }

  async function applyShareToRoom(roomId) {
    const share = pendingShare;
    pendingShare = null;
    shareTargetModal.hidden = true;
    if (!share) return;
    await redirectTo(roomId); // kein eigener Verlaufseintrag — "zurück" soll nicht auf dieses (bereits übernommene) Auswahl-Formular führen
    const textParts = [share.text, share.url].filter(Boolean);
    if (textParts.length) {
      const shared = textParts.join(' ');
      textInput.value = textInput.value ? `${textInput.value} ${shared}` : shared;
      autoGrow();
    }
    if (share.files.length) { pendingFiles.push(...share.files); renderPendingFiles(); }
    textInput.focus();
  }

  /**
   * `true`, solange dieser Screen über den Router kam (`/share/<id>` bzw.
   * `/share-blocked`, s. showShareTargetScreen()/showShareBlockedScreen())
   * — dann hinterlässt navigate() einen echten Verlaufseintrag, "Abbrechen"
   * muss also history.back() sein (closeScreen()). Weiterleiten (msg-action-
   * forward-Handler unten) öffnet dasselbe Modal dagegen AD-HOC, ohne
   * Router-Beteiligung — dort wäre closeScreen() falsch (könnte je nach
   * vorherigem Verlauf aus dem gerade offenen Chat heraus navigieren statt
   * nur dieses Modal zu schließen).
   */
  let shareTargetIsRouted = false;
  function closeShareTargetModal() {
    pendingShare = null;
    if (shareTargetIsRouted) closeScreen(); else shareTargetModal.hidden = true;
  }
  $('share-target-cancel-btn').addEventListener('click', closeShareTargetModal);
  shareTargetModal.addEventListener('click', (ev) => { if (ev.target === shareTargetModal) closeShareTargetModal(); });

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
  // Verschlüsselung (fest an, s. isRoomEncrypted())/Löschen für JEDEN
  // Chat, Umbenennen/Mitglieder nur für eine Gruppe (chatSettingsGroupSection
  // wird für einen DM versteckt). ---

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
    activeRoomId = roomId; // Einstellungen gehören zu GENAU diesem Raum — bleibt "aktiv" wie im Chat-Screen selbst, siehe renderPresence() u. a., die harmlos auf jetzt verstecktes Markup zielen, falls der darunterliegende Chat-Screen selbst gerade nicht sichtbar ist.
    chatSettingsTitleEl.textContent = roomDisplayName(room);
    chatSettingsGroupSection.hidden = !isGroupRoom(room);
    if (isGroupRoom(room)) {
      groupNameInput.value = room.name ?? '';
      groupAddMemberInput.value = '';
      groupDetailsError.textContent = '';
      renderGroupMemberList(roomId);
    }
    chatMuteToggle.checked = isRoomMuted(roomId);
    chatSettingsModal.hidden = false;
  }
  $('chat-settings-close-btn').addEventListener('click', closeScreen);
  chatSettingsModal.addEventListener('click', (ev) => { if (ev.target === chatSettingsModal) closeScreen(); });
  chatMuteToggle.addEventListener('change', () => {
    if (!activeRoomId) return;
    setRoomMuted(activeRoomId, chatMuteToggle.checked);
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
    // Avatar/Alias eines DMs muss hier nicht mehr nachgeladen/neu gerendert
    // werden — <qu-profile-card> in renderRoomList() aktualisiert sich für
    // jede Zeile bereits selbst, sobald die Werte eintreffen.
    ensureRoom(r.id).catch((e) => console.error('[chat] ensureRoom failed:', r.id, e));
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
