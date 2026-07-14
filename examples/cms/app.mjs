// Beispiel 7 (Oberfläche): siehe ../cms-lib.mjs für die eigentliche Logik
// und ../cms-router.js für das Hash-/Präsentations-Routing — diese Datei
// ist nur die dünne UI-Schicht darüber, im selben Stil wie
// examples/../archive/examples/03-todo-list.mjs (dünn, manuell rendern,
// kein Framework).
//
// Ohne `#...` in der URL wird beim ersten Laden eine neue Site samt
// Beispielinhalt angelegt (Readme/API/Beispiele — dieselben drei Themen
// wie /docs/examples.html) und der Hash auf `#<siteId>/home` gesetzt; das
// IST der Teilen-Link (siehe Box "Site teilen"). Mit `#...` im Link wird
// stattdessen die referenzierte Site geöffnet.

import { createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../../src/index.js';
import {
  createSite, getSiteManifest, canWrite, grantWriteAccess, revokeWriteAccess,
  getConfig, onConfig, setNavigationMode,
  setTemplate, getTemplate,
  setPage, onPage,
  addNavItem, listNav, onNav,
  presentRoute,
} from '../cms-lib.mjs';
import { watchRoute, navigate } from '../cms-router.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { parseHashRoute, buildHashRoute } from '../space-app-lib.mjs';

const IDENTITY_KEY = 'qu-cms-identity-keys'; // eigener Key, unabhängig von anderen Beispielen

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const shareBox = el('share-box');
const shareLinkEl = el('share-link');
const grantForm = el('grant-form');
const grantInput = el('grant-fp');
const writersEl = el('writers');
const readonlyNoticeEl = el('readonly-notice');
const modeLabelEl = el('mode-label');
const modeExplainEl = el('mode-explain');
const modeToggleBtn = el('mode-toggle');
const siteTitleEl = el('site-title');
const navListEl = el('nav-list');
const presentControlsEl = el('present-controls');
const pageEl = el('page');
const editorBox = el('editor-box');
const editingSlugEl = el('editing-slug');
const editTitleInput = el('edit-title');
const editBodyInput = el('edit-body');
const savePageBtn = el('save-page');
const addNavBox = el('add-nav-box');
const addNavForm = el('add-nav-form');
const navLabelInput = el('nav-label');
const navSlugInput = el('nav-slug');

/** Sehr kleine Platzhalter-Ersetzung — `{{title}}`/`{{body}}` im Template-HTML werden textinhalt-sicher (kein `innerHTML` mit rohen Nutzereingaben) durch den jeweiligen Seiteninhalt ersetzt. */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
function renderTemplate(templateHtml, vars) {
  return templateHtml.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(vars[key]));
}

async function seedDemoSite(qu) {
  const siteId = await createSite(qu, { title: 'QU-CMS Demo', writers: [qu.fingerprint] });
  await setTemplate(qu, siteId, 'default', '<h1>{{title}}</h1><div class="block">{{body}}</div>');
  await setPage(qu, siteId, 'home', { title: 'Willkommen', blocks: { body: 'Diese Seite lebt komplett im QU-Store dieser Site — Inhalte, Templates und Konfiguration in einem Space.' } });
  await setPage(qu, siteId, 'api', { title: 'API-Doku', blocks: { body: 'Siehe /API.md für die vollständige Referenz. Diese Seite ist selbst nur ein QuBit unter cms/pages/api.' } });
  await setPage(qu, siteId, 'examples', { title: 'Beispiele', blocks: { body: 'Siehe /docs/examples.html für weitere fokussierte Module.' } });
  await addNavItem(qu, siteId, { label: 'Start', slug: 'home', order: 1 });
  await addNavItem(qu, siteId, { label: 'API-Doku', slug: 'api', order: 2 });
  await addNavItem(qu, siteId, { label: 'Beispiele', slug: 'examples', order: 3 });
  return siteId;
}

async function main() {
  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  const { spaceId: hashSiteId } = parseHashRoute(location.hash);
  let siteId = hashSiteId;
  if (!siteId) {
    siteId = await seedDemoSite(qu);
    location.hash = buildHashRoute(siteId, 'home');
  }

  const repl = await qu.connect(channel, { pushTopics: [`${siteId}/`] });
  statusEl.textContent = 'Synchronisiere …';
  // Ein einziger sync() reicht in beide Richtungen (reziprok, siehe
  // APP-GUIDE.md Schritt 5): ein frisch erzeugter Site-Ersteller PUSHT
  // damit die gerade seedDemoSite()-geschriebenen Daten zum Relay (sie
  // entstanden VOR qu.connect(), pushTopics greift nur für Schreibungen
  // danach — ohne diesen Aufruf bliebe der Relay leer, bis der Owner
  // zufällig irgendetwas Neues schreibt); ein Besucher holt sich damit
  // genau denselben Stand ab.
  await repl.sync({ topic: siteId, since: 0 });
  statusEl.textContent = 'Verbunden';

  shareLinkEl.value = `${location.origin}${location.pathname}${buildHashRoute(siteId, 'home')}`;
  shareBox.hidden = false;

  let currentRoute = 'home';
  let currentMode = 'local';
  let writable = false;
  let offPage = null;

  async function refreshPermissions() {
    writable = await canWrite(qu, siteId);
    readonlyNoticeEl.hidden = writable;
    editorBox.hidden = !writable;
    addNavBox.hidden = !writable;
    modeToggleBtn.hidden = !writable;

    const manifest = await getSiteManifest(qu, siteId);
    const isAdmin = manifest?.admins?.includes(qu.fingerprint);
    grantForm.hidden = !isAdmin;

    writersEl.textContent = '';
    for (const fp of manifest?.writers ?? []) {
      const item = document.createElement('span');
      item.className = 'writer-item';
      item.textContent = fp === qu.fingerprint ? `${fp.slice(0, 10)}… (du)` : `${fp.slice(0, 10)}…`;
      // '*' (offen für alle) und die eigene Identität sind hier nicht entfernbar — letzteres, damit sich kein Admin über die UI versehentlich selbst aussperrt (revokeWriteAccess() selbst erlaubt es technisch, siehe space-app-lib.mjs).
      if (isAdmin && fp !== '*' && fp !== qu.fingerprint) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-writer';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Schreibrecht entziehen';
        removeBtn.addEventListener('click', async () => {
          await revokeWriteAccess(qu, siteId, fp);
          await refreshPermissions();
        });
        item.appendChild(removeBtn);
      }
      writersEl.appendChild(item);
    }
  }

  async function renderNav() {
    const items = await listNav(qu, siteId);
    navListEl.textContent = '';
    presentControlsEl.textContent = '';
    presentControlsEl.hidden = !(writable && currentMode === 'presentation');
    for (const item of items) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = buildHashRoute(siteId, item.value.slug);
      a.textContent = item.value.label;
      if (item.value.slug === currentRoute) a.className = 'active';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        navigate(siteId, item.value.slug); // im "local"-Modus wechselt das die Seite; im "presentation"-Modus nur der eigene Hash, siehe cms-router.js
      });
      li.appendChild(a);
      navListEl.appendChild(li);

      if (writable && currentMode === 'presentation') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `Präsentieren: ${item.value.label}`;
        btn.addEventListener('click', () => presentRoute(qu, siteId, item.value.slug));
        presentControlsEl.appendChild(btn);
      }
    }
  }

  async function renderPage(route) {
    offPage?.();
    editingSlugEl.textContent = route;
    offPage = onPage(qu, siteId, route, async (q) => {
      if (!q?.value) {
        pageEl.innerHTML = `<em>Seite "${escapeHtml(route)}" existiert noch nicht.</em>`;
        editTitleInput.value = '';
        editBodyInput.value = '';
        return;
      }
      const { title, template, blocks } = q.value;
      const templateHtml = (await getTemplate(qu, siteId, template)) ?? '<h1>{{title}}</h1><div>{{body}}</div>';
      pageEl.innerHTML = renderTemplate(templateHtml, { title, body: blocks?.body ?? '' });
      editTitleInput.value = title;
      editBodyInput.value = blocks?.body ?? '';
    });
  }

  function updateModeUI() {
    modeLabelEl.textContent = currentMode === 'presentation' ? 'Präsentationsmodus' : 'Lokal (jede:r navigiert selbst)';
    modeExplainEl.textContent = currentMode === 'presentation'
      ? 'alle Besucher sehen dieselbe Seite, gesteuert von einem Writer dieser Site.'
      : `Hash-Route pro Client (#${siteId}/pfad).`;
    modeToggleBtn.textContent = currentMode === 'presentation' ? 'Auf "lokal" umschalten' : 'Auf "Präsentation" umschalten';
  }

  onConfig(qu, siteId, (q) => {
    if (!q?.value) return;
    siteTitleEl.textContent = q.value.title;
  });

  await refreshPermissions();
  onNav(qu, siteId, () => renderNav());

  watchRoute(qu, {
    defaultSiteId: siteId,
    onRoute: ({ route, mode }) => {
      currentRoute = route;
      currentMode = mode;
      updateModeUI();
      renderNav();
      renderPage(route);
    },
  });

  modeToggleBtn.addEventListener('click', async () => {
    const config = await getConfig(qu, siteId);
    await setNavigationMode(qu, siteId, config.navigationMode === 'presentation' ? 'local' : 'presentation');
  });

  savePageBtn.addEventListener('click', async () => {
    await setPage(qu, siteId, currentRoute, {
      title: editTitleInput.value.trim() || currentRoute,
      blocks: { body: editBodyInput.value },
    });
  });

  addNavForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const label = navLabelInput.value.trim();
    const slug = navSlugInput.value.trim();
    if (!label || !slug) return;
    await addNavItem(qu, siteId, { label, slug, order: (await listNav(qu, siteId)).length + 1 });
    navLabelInput.value = '';
    navSlugInput.value = '';
  });

  grantForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fp = grantInput.value.trim();
    if (!fp) return;
    await grantWriteAccess(qu, siteId, fp);
    grantInput.value = '';
    await refreshPermissions();
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
