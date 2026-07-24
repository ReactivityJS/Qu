// People — globales Identitäten-Verzeichnis auf Basis von QU. Dieselbe
// Identität wie examples/chat (siehe dessen app.mjs's IDENTITY_KEY-Doku:
// beide teilen bewusst denselben localStorage-Key, EIN Fingerprint fürs
// gesamte Ökosystem, kein pro-App-Konto). Adress-/Formatierungslogik ohne
// `window` steckt in people-lib.mjs, hier nur Rendering/Netzwerk/Router —
// derselbe Schnitt wie examples/chat/chat-lib.mjs vs. app.mjs.

import {
  createNetworkPlugin, createSpacesPlugin, createProfilesPlugin, createWebSocketChannel, DIRECTORY_ID,
} from '../../src/index.js';
import { buildPath, parsePathSegments } from '../../src/ui/hash-router.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { matchesQuery, sortDirectory, isValidFingerprint } from './people-lib.mjs';
import '../../src/ui/profile-components.js'; // Seiteneffekt: registriert <qu-profile-card>

const IDENTITY_KEY = 'qu-identity'; // siehe examples/chat/app.mjs's IDENTITY_KEY-Doku — bewusst derselbe Wert

function $(id) { return document.getElementById(id); }
const appEl = $('app');
const searchInput = $('search-input');
const meAvatarBtn = $('me-avatar');
const directoryListEl = $('directory-list');
const emptyStateEl = $('empty-state');

const profileModal = $('profile-modal');
const avatarPreviewBtn = $('avatar-preview-btn');
const avatarInput = $('avatar-input');
const aliasInput = $('alias-input');
const myFpFullEl = $('my-fp-full');
const visibleToggle = $('visible-toggle');
const attrListEl = $('attr-list');
const attrEmptyEl = $('attr-empty');
const attrKeyInput = $('attr-key-input');
const attrValueInput = $('attr-value-input');
const attrPrivateToggle = $('attr-private-toggle');
const attrErrorEl = $('attr-error');

const viewProfileModal = $('view-profile-modal');
const viewAvatarEl = $('view-avatar');
const viewAliasEl = $('view-alias');
const viewFpEl = $('view-fp');
const viewAttrListEl = $('view-attr-list');
const viewAttrEmptyEl = $('view-attr-empty');

function initialsOf(name) {
  return (name || '?').trim().slice(0, 2).toUpperCase();
}
function setAvatar(target, name, avatarDataUrl) {
  target.textContent = '';
  if (avatarDataUrl) {
    const img = document.createElement('img');
    img.src = avatarDataUrl;
    img.alt = '';
    target.appendChild(img);
  } else {
    target.append(initialsOf(name));
  }
}
/** Ein hochgeladenes Bild client-seitig auf ein kleines, quadratisches JPEG verkleinern — derselbe Ansatz wie examples/chat/app.mjs's resizeAvatar(), hier dupliziert statt geteilt (zwei generische DOM-Helfer sind kein Modul wert, siehe dessen Kommentar). */
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

async function main() {
  const qu = await loadOrCreateIdentity(IDENTITY_KEY);
  qu.use(createNetworkPlugin()).use(createSpacesPlugin()).use(createProfilesPlugin());
  appEl.qu = qu; // EIN Ort setzt den Qu-Kontext für jedes <qu-profile-card> unter #app (src/ui/components.js's findQu())
  viewProfileModal.qu = qu; // eigener Teilbaum außerhalb von #app, siehe hideAllScreens()

  let repl;
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function connectToRelay() {
    const channel = createWebSocketChannel(relayUrl());
    await Promise.race([
      channel.connect(),
      wait(10000).then(() => { throw new Error('Zeitüberschreitung beim Verbindungsaufbau'); }),
    ]);
    repl = await qu.connect(channel, { pushTopics: [''] });
  }
  async function connectWithRetry() {
    for (let attempt = 0; ; attempt++) {
      try { await connectToRelay(); return; } catch (e) {
        console.error('[people] connect failed:', e);
        await wait(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
  }
  window.addEventListener('online', () => { connectToRelay().catch((e) => console.error('[people] reconnect failed:', e)); });

  await connectWithRetry();
  // ERST syncen/lesen, DANN publishProfile() — die Identität ist über
  // examples/chat geteilt (IDENTITY_KEY-Doku oben), ein dort bereits
  // gewählter Alias könnte also längst existieren, ohne dass DIESE
  // Session-Instanz (eigener, leerer lokaler Store) davon weiß. Blind
  // `qu.publishProfile()` ohne Alias aufzurufen würde ihn (publishProfile()
  // schreibt `alias` seit qu.js's neuestem Default IMMER, siehe dessen
  // Doku) mit dem Fingerprint überschreiben — read-before-write verhindert
  // das: der gelesene (ggf. schon vorhandene) Alias wird unverändert
  // zurückgeschrieben, wodurch nur pub/epub sicher publiziert werden (für
  // eine ganz neue Identität, die noch NIE publishProfile() aufgerufen
  // hat), ohne je einen echten Alias zu verlieren.
  await repl.sync({ topic: qu.userSpaceId }).catch((e) => console.error('[people] self-profile sync failed:', e));
  myFpFullEl.textContent = qu.fingerprint;
  const myProfile = await qu.readProfile(qu.fingerprint);
  await qu.publishProfile({ alias: myProfile.alias });
  let myAvatarQ = await qu.get(`~${qu.fingerprint}/avatar`);
  setAvatar(meAvatarBtn, myProfile.alias, myAvatarQ?.value ?? null);

  // --- Verzeichnis (Liste + Live-Aktualisierung + Suche) ---
  let directoryEntries = []; // [{ fingerprint }]
  const aliasCache = new Map(); // fp -> alias (für die Suche — die eigentliche Anzeige macht <qu-profile-card> selbst reaktiv)
  const aliasUnsubs = new Map(); // fp -> unsub, nur solange der Eintrag sichtbar im Verzeichnis ist

  function renderDirectoryList() {
    const withAlias = directoryEntries.map((e) => ({ fingerprint: e.fingerprint, alias: aliasCache.get(e.fingerprint) ?? e.fingerprint }));
    const filtered = withAlias.filter((e) => matchesQuery(e, searchInput.value));
    const sorted = sortDirectory(filtered);
    directoryListEl.textContent = '';
    emptyStateEl.classList.toggle('show', directoryEntries.length === 0);
    for (const entry of sorted) {
      const li = document.createElement('li');
      const card = document.createElement('qu-profile-card');
      card.setAttribute('fp', entry.fingerprint);
      card.setAttribute('href', '#/{fp}');
      li.appendChild(card);
      directoryListEl.appendChild(li);
    }
  }

  async function refreshDirectory() {
    directoryEntries = await qu.listDirectory();
    const currentFps = new Set(directoryEntries.map((e) => e.fingerprint));
    for (const fp of [...aliasUnsubs.keys()]) {
      if (!currentFps.has(fp)) { aliasUnsubs.get(fp)?.(); aliasUnsubs.delete(fp); aliasCache.delete(fp); }
    }
    for (const { fingerprint: fp } of directoryEntries) {
      if (aliasUnsubs.has(fp)) continue;
      await repl.sync({ topic: `~${fp}` }).catch((e) => console.error('[people] directory profile sync failed:', fp, e));
      const profile = await qu.readProfile(fp).catch(() => null);
      aliasCache.set(fp, profile?.alias ?? fp);
      aliasUnsubs.set(fp, qu.get(`~${fp}`).get('alias').on((q) => {
        aliasCache.set(fp, q?.value ?? fp);
        renderDirectoryList();
      }));
      renderDirectoryList();
    }
    renderDirectoryList();
  }
  qu.onDirectoryChange(() => refreshDirectory());
  searchInput.addEventListener('input', renderDirectoryList);
  await refreshDirectory();

  // --- Router ---
  // Dasselbe Prinzip wie examples/chat/app.mjs's Router: `location.hash`
  // IST der Zustand ("welcher Screen ist offen"), navigate()/redirectTo()
  // sind der einzige Ort, der ihn setzt, renderRoute() der einzige, der
  // ihn liest und Screens zeigt/versteckt — siehe dort für die
  // ausführliche Begründung (history.back()-Garantie, Dedup-Wächter).
  //
  // Pfadschema (src/ui/hash-router.js):
  //   /            Verzeichnis (Wurzel-Screen, kein Hash)
  //   /profile     eigenes Profil
  //   /<fp>        fremdes Profil — die eigene Fingerprint-Route leitet
  //                auf /profile um (kanonische Route für "mich selbst")
  async function navigate(...segments) {
    const hash = segments.length ? buildPath(...segments) : '#/';
    if (location.hash === hash) return renderRoute();
    location.hash = hash;
    return renderRoute();
  }
  async function redirectTo(...segments) {
    const hash = segments.length ? buildPath(...segments) : '#/';
    history.replaceState(null, '', location.pathname + hash);
    return renderRoute();
  }
  function closeScreen() { history.back(); }
  function hideAllScreens() {
    profileModal.hidden = true;
    viewProfileModal.hidden = true;
  }

  let lastRenderedHash = null;
  async function renderRoute() {
    if (location.hash === lastRenderedHash) return;
    lastRenderedHash = location.hash;
    const [first] = parsePathSegments(location.hash);
    hideAllScreens();
    if (!first) return;
    if (first === 'profile') { await showProfileScreen(); return; }
    if (first === qu.fingerprint) { await redirectTo('profile'); return; } // die eigene Fingerprint-Route ist immer /profile
    if (!isValidFingerprint(first)) { await redirectTo(); return; } // kein Fingerprint -> zurück zum Verzeichnis, kein Verlaufseintrag dafür
    await showViewProfileScreen(first);
  }
  window.addEventListener('hashchange', renderRoute);
  meAvatarBtn.addEventListener('click', () => navigate('profile'));
  $('profile-back-btn').addEventListener('click', closeScreen);
  $('view-profile-back-btn').addEventListener('click', closeScreen);
  profileModal.addEventListener('click', (ev) => { if (ev.target === profileModal) closeScreen(); });
  viewProfileModal.addEventListener('click', (ev) => { if (ev.target === viewProfileModal) closeScreen(); });

  // --- Eigenes Profil — /profile ---
  let pendingAvatar; // undefined = unverändert, null = "entfernen", sonst neue Data-URL
  async function showProfileScreen() {
    pendingAvatar = undefined;
    aliasInput.value = myProfile.alias === qu.fingerprint ? '' : myProfile.alias;
    aliasInput.placeholder = qu.fingerprint;
    setAvatar(avatarPreviewBtn, myProfile.alias, myAvatarQ?.value ?? null);
    const ownEntry = await qu.get(`${DIRECTORY_ID}/entries/${qu.fingerprint}`);
    visibleToggle.checked = !!ownEntry?.value?.visible;
    attrErrorEl.textContent = '';
    await renderOwnAttrs();
    profileModal.hidden = false;
  }
  $('avatar-pick-btn').addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    avatarInput.value = '';
    if (!file) return;
    pendingAvatar = await resizeAvatar(file);
    setAvatar(avatarPreviewBtn, aliasInput.value, pendingAvatar);
  });
  $('avatar-clear-btn').addEventListener('click', () => {
    pendingAvatar = null;
    setAvatar(avatarPreviewBtn, aliasInput.value || qu.fingerprint, null);
  });
  $('profile-save-btn').addEventListener('click', async () => {
    const alias = aliasInput.value.trim() || qu.fingerprint;
    await qu.publishProfile({ alias });
    if (pendingAvatar !== undefined) await qu.own.get('avatar').put(pendingAvatar);
    await qu.setDirectoryVisible(visibleToggle.checked);
    myProfile.alias = alias;
    myAvatarQ = { value: pendingAvatar !== undefined ? pendingAvatar : myAvatarQ?.value };
    setAvatar(meAvatarBtn, alias, myAvatarQ.value);
    closeScreen();
  });

  async function renderOwnAttrs() {
    const attrs = await qu.listProfileAttrs(qu.fingerprint);
    renderAttrList(attrListEl, attrEmptyEl, attrs, { removable: true });
  }
  function renderAttrList(listEl, emptyEl, attrs, { removable = false } = {}) {
    const keys = Object.keys(attrs);
    listEl.textContent = '';
    emptyEl.hidden = keys.length > 0;
    for (const key of keys) {
      const li = document.createElement('li');
      li.className = 'attr-row';
      const keyEl = document.createElement('span');
      keyEl.className = 'attr-key';
      keyEl.textContent = key;
      const valueEl = document.createElement('span');
      valueEl.className = 'attr-value';
      valueEl.textContent = attrs[key];
      li.append(keyEl, valueEl);
      if (removable) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'attr-remove-btn';
        removeBtn.title = 'Entfernen';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', async () => {
          await qu.deleteProfileAttr(key);
          await renderOwnAttrs();
        });
        li.appendChild(removeBtn);
      }
      listEl.appendChild(li);
    }
  }
  $('attr-add-btn').addEventListener('click', async () => {
    const key = attrKeyInput.value.trim();
    const value = attrValueInput.value.trim();
    attrErrorEl.textContent = '';
    if (!key || !value) { attrErrorEl.textContent = 'Feldname und Wert sind erforderlich.'; return; }
    await qu.setProfileAttr(key, value, attrPrivateToggle.checked ? { encryptFor: [qu.fingerprint] } : {});
    attrKeyInput.value = '';
    attrValueInput.value = '';
    attrPrivateToggle.checked = false;
    await renderOwnAttrs();
  });

  // --- Fremdes Profil — /<fp> ---
  async function showViewProfileScreen(fp) {
    await repl.sync({ topic: `~${fp}` }).catch((e) => console.error('[people] profile sync failed:', fp, e));
    const profile = await qu.readProfile(fp).catch(() => ({ alias: fp }));
    viewAliasEl.textContent = profile.alias;
    viewFpEl.textContent = fp;
    let avatarQ = null;
    try { avatarQ = await qu.get(`~${fp}/avatar`); } catch { /* kein Avatar */ }
    setAvatar(viewAvatarEl, profile.alias, avatarQ?.value ?? null);
    const attrs = await qu.listProfileAttrs(fp);
    renderAttrList(viewAttrListEl, viewAttrEmptyEl, attrs, { removable: false });
    viewProfileModal.hidden = false;
  }

  // Erste Route rendern — dieselbe Direktlink-Normalisierung wie
  // examples/chat/app.mjs (siehe dessen Router-Doku): "zurück" landet aus
  // JEDEM Screen, auch einem direkt verlinkten, garantiert auf dem
  // Verzeichnis statt die App zu verlassen.
  if (location.hash && location.hash !== '#/') {
    const target = parsePathSegments(location.hash);
    history.replaceState(null, '', location.pathname);
    if (target.length) await navigate(...target);
  } else {
    await renderRoute();
  }
}

main().catch((e) => { console.error('[people] startup failed:', e); document.body.textContent = `Fehler beim Start: ${e.message}`; });
