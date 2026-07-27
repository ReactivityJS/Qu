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
  setTemplate, getTemplate, onTemplate,
  setPage, onPage,
  addNavItem, listNav, onNav,
  presentRoute,
} from '../cms-lib.mjs';
import { watchRoute, navigate } from '../cms-router.js';
import { loadOrCreateIdentity, relayUrl, ECOSYSTEM_IDENTITY_KEY } from '../space-app-browser.js';
import { parseHashRoute, buildHashRoute, isPublic, setPublic, listReaders, addReader, removeReader } from '../space-app-lib.mjs';

// Bis hierhin ein eigener, von anderen Beispielen unabhängiger Key
// ('qu-cms-identity-keys') — inzwischen überholt: EIN Fingerprint fürs
// gesamte Ökosystem (siehe src/ui/session-bootstrap.js's Doku zu
// ECOSYSTEM_IDENTITY_KEY), nicht ein Konto pro App. `migrateFrom` unten
// kopiert eine bereits bestehende CMS-Identität einmalig auf den neuen,
// gemeinsamen Key, statt Bestandsnutzer:innen ihre bisherige Identität zu nehmen.
const LEGACY_IDENTITY_KEY = 'qu-cms-identity-keys';

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const shareBox = el('share-box');
const shareLinkEl = el('share-link');
const grantForm = el('grant-form');
const grantInput = el('grant-fp');
const writersEl = el('writers');
const readonlyNoticeEl = el('readonly-notice');
const visibilityBox = el('visibility-box');
const visibilityLabelEl = el('visibility-label');
const visibilityToggleBtn = el('visibility-toggle');
const readersSection = el('readers-section');
const readersEl = el('readers');
const addReaderForm = el('add-reader-form');
const readerFpInput = el('reader-fp');
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
const editorToolbar = document.querySelector('.editor-toolbar');
const savePageBtn = el('save-page');
const templateBox = el('template-box');
const editingTemplateEl = el('editing-template');
const editTemplateInput = el('edit-template');
const saveTemplateBtn = el('save-template');
const addNavBox = el('add-nav-box');
const addNavForm = el('add-nav-form');
const navLabelInput = el('nav-label');
const navSlugInput = el('nav-slug');

/** Textinhalt-sicheres Escaping für `{{key}}`-Platzhalter (kein `innerHTML` mit rohen Nutzereingaben). */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

/**
 * `{{{key}}}` (drei Klammern, Mustache-Konvention) setzt `vars[key]` RAW als
 * HTML ein — für den Seiten-Body aus dem WYSIWYG-Editor unten, der bereits
 * HTML ist (Fett/Kursiv/Links/Überschriften). `{{key}}` (zwei Klammern)
 * bleibt escaped — für einfache Textfelder wie den Titel. Sicherheitsmodell:
 * NUR ein Writer dieser Site kann Seiten-Body ODER Template überhaupt
 * schreiben (ACL-geprüft, siehe cms-lib.mjs) — wer Schreibrecht hat, kann
 * ohnehin schon beliebiges HTML in ein Template legen (setTemplate() prüft
 * nichts), das rohe Einsetzen des Bodys eröffnet also KEINE neue Fähigkeit,
 * nur denselben bereits vorhandenen Vertrauens-/Berechtigungsrahmen über
 * eine komfortablere Oberfläche (siehe GUIDE.md Abschnitt 6).
 */
function renderTemplate(templateHtml, vars) {
  return templateHtml
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => vars[key] ?? '')
    .replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(vars[key]));
}

async function seedDemoSite(qu) {
  const siteId = await createSite(qu, { title: 'QU-CMS Demo', writers: [qu.fingerprint] });
  await setTemplate(qu, siteId, 'default', '<h1>{{title}}</h1><div class="block">{{{body}}}</div>');
  await setPage(qu, siteId, 'home', { title: 'Willkommen', blocks: { body: 'Diese Seite lebt komplett im QU-Store dieser Site — Inhalte, Templates und Konfiguration in einem Space.' } });
  await setPage(qu, siteId, 'api', { title: 'API-Doku', blocks: { body: 'Siehe /API.md für die vollständige Referenz. Diese Seite ist selbst nur ein QuBit unter cms/pages/api.' } });
  await setPage(qu, siteId, 'examples', { title: 'Beispiele', blocks: { body: 'Siehe /docs/examples.html für weitere fokussierte Module.' } });
  await addNavItem(qu, siteId, { label: 'Start', slug: 'home', order: 1 });
  await addNavItem(qu, siteId, { label: 'API-Doku', slug: 'api', order: 2 });
  await addNavItem(qu, siteId, { label: 'Beispiele', slug: 'examples', order: 3 });
  return siteId;
}

async function main() {
  const qu = (await loadOrCreateIdentity(ECOSYSTEM_IDENTITY_KEY, { migrateFrom: LEGACY_IDENTITY_KEY })).use(createNetworkPlugin()).use(createSpacesPlugin());
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
  let offTemplate = null;

  /**
   * Gemeinsame Chip-Liste für Writer UND Reader (beides einfach Fingerprint-
   * Listen im selben Manifest, siehe space-app-lib.mjs's addToRole()/
   * removeFromRole()) — ein Renderer statt zwei fast identischer.
   * Die eigene Identität ist nie entfernbar, damit sich kein Admin über die
   * UI versehentlich selbst aussperrt (die Bibliotheksfunktion selbst
   * erlaubt es technisch, siehe deren Doku).
   */
  function renderFingerprintChips(container, fingerprints, { canRemove, onRemove }) {
    container.textContent = '';
    for (const fp of fingerprints) {
      const item = document.createElement('span');
      item.className = 'fp-chip';
      item.textContent = fp === qu.fingerprint ? `${fp.slice(0, 10)}… (du)` : `${fp.slice(0, 10)}…`;
      if (canRemove && fp !== qu.fingerprint) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove-fp';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', () => onRemove(fp));
        item.appendChild(removeBtn);
      }
      container.appendChild(item);
    }
  }

  async function refreshPermissions() {
    writable = await canWrite(qu, siteId);
    readonlyNoticeEl.hidden = writable;
    editorBox.hidden = !writable;
    templateBox.hidden = !writable;
    addNavBox.hidden = !writable;
    modeToggleBtn.hidden = !writable;

    const manifest = await getSiteManifest(qu, siteId);
    const isAdmin = manifest?.admins?.includes(qu.fingerprint);
    grantForm.hidden = !isAdmin;
    visibilityBox.hidden = !isAdmin;

    renderFingerprintChips(writersEl, (manifest?.writers ?? []).filter((fp) => fp !== '*'), {
      canRemove: isAdmin,
      onRemove: async (fp) => { await revokeWriteAccess(qu, siteId, fp); await refreshPermissions(); },
    });

    if (isAdmin) {
      const publicSite = await isPublic(qu, siteId);
      visibilityLabelEl.textContent = publicSite ? 'öffentlich lesbar' : 'privat';
      readersSection.hidden = publicSite;
      if (!publicSite) {
        renderFingerprintChips(readersEl, await listReaders(qu, siteId), {
          canRemove: true,
          onRemove: async (fp) => { await removeReader(qu, siteId, fp); await refreshPermissions(); },
        });
      }
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

  let currentTemplateName = 'default';

  async function loadTemplateEditor(name) {
    currentTemplateName = name;
    editingTemplateEl.textContent = name;
    editTemplateInput.value = (await getTemplate(qu, siteId, name)) ?? '';
  }

  /**
   * Reagiert auf ZWEI unabhängige Live-Quellen: die Seite selbst
   * (onPage()) UND das von ihr referenzierte Template (onTemplate()) — ein
   * Template-Update muss die gerade offene Seite sofort neu rendern, ohne
   * dass sich an der Seite selbst etwas geändert hätte (genau der Zweck, den
   * cms-lib.mjs's onTemplate()-Doku beschreibt). Die Editor-Felder werden
   * NUR bei einer Seitenänderung zurückgesetzt, nicht bei einer reinen
   * Template-Änderung — sonst würde ein fremdes Template-Update laufende
   * Eingaben in editBodyInput überschreiben.
   */
  async function renderPage(route) {
    offPage?.(); offPage = null;
    offTemplate?.(); offTemplate = null;
    editingSlugEl.textContent = route;
    let currentPage = null;

    function renderCurrent(templateHtml) {
      if (!currentPage) {
        pageEl.innerHTML = `<em>Seite "${escapeHtml(route)}" existiert noch nicht.</em>`;
        return;
      }
      const { title, blocks } = currentPage;
      pageEl.innerHTML = renderTemplate(templateHtml ?? '<h1>{{title}}</h1><div>{{{body}}}</div>', { title, body: blocks?.body ?? '' });
    }

    offPage = onPage(qu, siteId, route, async (q) => {
      currentPage = q?.value ?? null;
      offTemplate?.(); offTemplate = null;

      if (!currentPage) {
        renderCurrent(null);
        editTitleInput.value = '';
        editBodyInput.innerHTML = '';
        await loadTemplateEditor('default');
        return;
      }

      editTitleInput.value = currentPage.title;
      editBodyInput.innerHTML = currentPage.blocks?.body ?? '';
      await loadTemplateEditor(currentPage.template);

      offTemplate = onTemplate(qu, siteId, currentPage.template, (t) => renderCurrent(t?.value));
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

  // Winzige WYSIWYG-Toolbar über execCommand() — bewusst die schlankeste
  // Umsetzung ohne jede Abhängigkeit (siehe package.json: "keine Laufzeit-
  // Abhängigkeiten"), kein neues Rich-Text-Framework. execCommand() ist
  // MDN-seitig als "veraltet" markiert, aber in jedem aktuellen Browser
  // weiterhin implementiert — für die paar Grundformate hier (fett, kursiv,
  // Überschrift, Liste, Link) reicht das; siehe GUIDE.md Abschnitt 7 für
  // die Abwägung und einen Verweis auf den Ausbaupfad, falls mehr gebraucht wird.
  editorToolbar.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-cmd]');
    if (!btn) return;
    editBodyInput.focus();
    const { cmd, value } = btn.dataset;
    if (cmd === 'createLink') {
      const url = prompt('Link-Ziel (URL):');
      if (url) document.execCommand(cmd, false, url);
    } else {
      document.execCommand(cmd, false, value ?? null);
    }
  });

  savePageBtn.addEventListener('click', async () => {
    await setPage(qu, siteId, currentRoute, {
      title: editTitleInput.value.trim() || currentRoute,
      template: currentTemplateName,
      blocks: { body: editBodyInput.innerHTML },
    });
  });

  saveTemplateBtn.addEventListener('click', async () => {
    await setTemplate(qu, siteId, currentTemplateName, editTemplateInput.value);
  });

  visibilityToggleBtn.addEventListener('click', async () => {
    await setPublic(qu, siteId, !(await isPublic(qu, siteId)));
    await refreshPermissions();
  });

  addReaderForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fp = readerFpInput.value.trim();
    if (!fp) return;
    await addReader(qu, siteId, fp);
    readerFpInput.value = '';
    await refreshPermissions();
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
