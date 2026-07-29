// App-Verzeichnis — browses every registered app/service (category
// 'service'/'custom', see server/service-registry.mjs's own file doc for
// the category taxonomy), lets ANY identity star/unstar one as a favorite
// (src/modules/favorites.js, shown at the top of shell/qu-nav-dropdown.mjs's
// menu), and — for a QU_RELAY_ADMINS fingerprint only — lets an admin
// enable/disable one right here, the SAME `admin/service/<id>` command
// examples/relay-admin/panel.mjs's own toggleService() uses. This is
// deliberately WHERE that toggle now lives (moved out of relay-admin,
// which used to have its own "Services" panel) — browsing apps and
// (de)activating one belong together, in the one screen an admin actually
// looks at apps from; relay-admin stays for genuine relay-wide operations
// (rate-limit, connection-limit, platform-modules, theme).
//
// Uses <qu-profile-card>-adjacent styling conventions but no Qu-Component
// of its own beyond plain DOM — there is no existing Qu-Component for
// "a catalog of non-identity records with actions per row" the way
// <qu-people-search>/<qu-list> cover identity/leaf-per-field collections;
// see services/hello-world/app.mjs for where <qu-view>/<qu-bind> ARE the
// right fit (this file's own doc explains why they aren't, here).
//
// Each row's name is also the app's own "open" link (`#/<id>`, in-shell —
// same mount-contract navigation qu-nav-dropdown.mjs's own catalog entries
// use). Two further, OPTIONAL per-app shortcuts read straight off the
// manifest (`hasSettings`/`hasAdmin`, see service-registry.mjs's own
// manifest-fields whitelist) — an app declares these only if it actually
// mounts something at `#/<id>/settings` / `#/<id>/admin` (services/hello-world
// is the reference example); `hasAdmin` is additionally gated on `isAdmin`
// here — same "UI convenience, not the real ACL boundary" stance as the
// enable/disable toggle below.

import { buildPath } from '../../src/index.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function mount(container, { qu }) {
  const heading = document.createElement('h2');
  heading.textContent = '🧩 App-Verzeichnis';
  const hint = document.createElement('p');
  hint.className = 'qu-app-directory-hint';
  hint.textContent = 'Alle Apps dieses Relays. ⭐ markiert einen persönlichen Favoriten (erscheint oben im Menü).';
  const status = document.createElement('p');
  status.className = 'qu-app-directory-status';
  status.hidden = true;
  const list = document.createElement('ul');
  list.className = 'qu-app-directory-list';
  container.append(heading, hint, status, list);

  function showStatus(message, kind) {
    status.textContent = message;
    status.className = `qu-app-directory-status ${kind}`;
    status.hidden = false;
  }

  // Purely a UI convenience, NOT a security check — same stance as
  // qu-app-shell.mjs's own _revealAdminLinkIfAdmin() (see its doc): a real
  // unauthorized admin/service/<id> write still fails at the relay's ACL
  // either way (relay/relay.mjs), this only decides whether to even show
  // the toggle button.
  let relayInfo;
  try {
    relayInfo = await fetchJSON('/relay/info');
  } catch (e) {
    console.error('[app-directory] failed to load /relay/info:', e);
    relayInfo = { fingerprint: null, epub: null, admins: [] };
  }
  const isAdmin = relayInfo.fingerprint && relayInfo.admins.includes(qu.fingerprint);
  if (isAdmin) await qu.session.trustPeer(relayInfo.fingerprint, relayInfo.epub).catch((e) => console.error('[app-directory] trustPeer failed:', e));

  let favorites = new Set();
  const rows = new Map(); // id -> <li>

  function renderRow(svc) {
    let li = rows.get(svc.id);
    if (!li) {
      li = document.createElement('li');
      li.className = 'qu-app-directory-row';
      rows.set(svc.id, li);
      list.appendChild(li);
    }
    li.textContent = '';

    const starBtn = document.createElement('button');
    starBtn.type = 'button';
    starBtn.className = 'qu-app-directory-star';
    starBtn.title = favorites.has(svc.id) ? 'Favorit entfernen' : 'Als Favorit markieren';
    starBtn.textContent = favorites.has(svc.id) ? '⭐' : '☆';
    starBtn.addEventListener('click', async () => {
      starBtn.disabled = true;
      try {
        if (favorites.has(svc.id)) await qu.removeFavorite(svc.id);
        else await qu.addFavorite(svc.id);
      } catch (e) {
        console.error('[app-directory] favorite toggle failed:', e);
      } finally {
        starBtn.disabled = false;
      }
    });

    const name = document.createElement('div');
    name.className = 'name';
    const label = document.createElement(svc.mount ? 'a' : 'div');
    label.textContent = `${svc.icon ? `${svc.icon} ` : ''}${svc.label}`;
    if (svc.mount) label.href = buildPath(svc.id); // entry-only (no mount) services have no in-shell page to link to — name stays plain text
    const desc = document.createElement('div');
    desc.className = 'id';
    desc.textContent = svc.description || svc.id;
    name.append(label, desc);

    const badge = document.createElement('span');
    badge.className = 'category-badge';
    badge.textContent = svc.enabled === false ? 'deaktiviert' : svc.category;

    li.append(starBtn, name, badge);

    if (svc.mount && svc.hasSettings) {
      const settingsLink = document.createElement('a');
      settingsLink.className = 'qu-app-directory-shortcut';
      settingsLink.href = buildPath(svc.id, 'settings');
      settingsLink.title = 'Einstellungen';
      settingsLink.textContent = '⚙️';
      li.appendChild(settingsLink);
    }
    if (svc.mount && svc.hasAdmin && isAdmin) {
      const adminLink = document.createElement('a');
      adminLink.className = 'qu-app-directory-shortcut';
      adminLink.href = buildPath(svc.id, 'admin');
      adminLink.title = 'Admin-Bereich';
      adminLink.textContent = '🛠️';
      li.appendChild(adminLink);
    }

    if (isAdmin) {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = svc.enabled === false ? 'disabled' : 'enabled';
      toggleBtn.textContent = svc.enabled === false ? '○ deaktiviert' : '● aktiv';
      toggleBtn.addEventListener('click', () => toggleService(svc, toggleBtn));
      li.appendChild(toggleBtn);
    }
  }

  /**
   * Same fire-and-forget-then-reread confirmation as
   * examples/relay-admin/panel.mjs's own toggleService() (verbatim
   * protocol, deliberately not imported/shared as one function — this
   * page's row shape differs enough, see renderRow() above, that sharing
   * would need its own indirection for little benefit; the PROTOCOL is
   * what has to stay identical, not the code path).
   */
  async function toggleService(svc, btn) {
    btn.disabled = true;
    try {
      await qu.session.publish(`admin/service/${svc.id}`, { enabled: svc.enabled === false }, { encryptFor: [relayInfo.fingerprint] });
      await wait(200);
      const services = await refreshCatalog();
      const updated = services.find((s) => s.id === svc.id);
      const expectedEnabled = svc.enabled === false;
      if (updated && (updated.enabled !== false) === expectedEnabled) {
        showStatus(`"${svc.label}" ${expectedEnabled ? 'aktiviert' : 'deaktiviert'}.`, 'ok');
      } else {
        showStatus(`"${svc.label}" unverändert — keine Bestätigung vom Relay erhalten. Ist deine Identität (${qu.fingerprint}) als QU_RELAY_ADMINS-Fingerprint hinterlegt?`, 'err');
      }
    } catch (e) {
      showStatus(`Fehlgeschlagen: ${e.message}`, 'err');
      btn.disabled = false;
    }
  }

  async function refreshCatalog() {
    const all = await fetchJSON('/relay/services');
    const apps = all.filter((s) => s.category === 'service' || s.category === 'custom');
    const seenIds = new Set(apps.map((s) => s.id));
    for (const [id, li] of rows) { if (!seenIds.has(id)) { li.remove(); rows.delete(id); } }
    for (const svc of apps) renderRow(svc);
    return all;
  }

  qu.onFavoritesChange((q) => {
    const appId = q.id.slice(q.id.lastIndexOf('/') + 1);
    if (q.value == null) favorites.delete(appId); else favorites.add(appId);
    const svcLi = rows.get(appId);
    if (svcLi) { // re-render just the star, cheapest path — full refreshCatalog() would also work but re-fetches the whole catalog for one icon flip
      const starBtn = svcLi.querySelector('.qu-app-directory-star');
      if (starBtn) {
        starBtn.textContent = favorites.has(appId) ? '⭐' : '☆';
        starBtn.title = favorites.has(appId) ? 'Favorit entfernen' : 'Als Favorit markieren';
      }
    }
  });

  await refreshCatalog();
}
