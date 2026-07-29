// `<qu-nav-dropdown>` — the ecosystem's quick-access menu, rendered as a
// dropdown. Unlike its earlier version, this DOES now need `.qu` (findQu(),
// same resolution every other Qu-Component here uses) — favorites
// (src/modules/favorites.js) are per-identity Space content, and the
// Admin-Portal link's visibility is a per-identity check against the
// relay's QU_RELAY_ADMINS list (GET /relay/info, same UI-convenience
// pattern qu-app-shell.mjs's own _revealAdminLinkIfAdmin() already uses —
// moved here instead of a separate header element, so there's exactly one
// admin-detection call site, not two).
//
// Deliberately NOT a flat list of every registered service anymore (that
// was this component's ENTIRE previous job) — browsing/searching the full
// catalog now belongs to services/app-directory (its own fixed link
// below), reachable from here in one click. This menu instead shows only:
//   1. ⭐ Favoriten — apps this identity starred (in App-Verzeichnis).
//   2. 🧩 App-Verzeichnis — the fixed link to the full catalog.
//   3. 🛠️ Admin-Portal — fixed link, shown only for a QU_RELAY_ADMINS fp.
//   4. A footer section — Examples/Documentation entries (one-off
//      reference material, not "apps" someone favorites/browses the way
//      App-Verzeichnis handles those; see nav-catalog.mjs's
//      footerEntries() for the exact category split).
//
// Light DOM only, no attachShadow() — see qu-app-shell.mjs's own doc
// comment for why (qu-profile-open/qu-people-search-results are
// bubbles:true but NOT composed:true, so a shadow boundary anywhere in
// this shell's render tree would silently swallow them).
//
// Fires a bubbling `qu-app-select` CustomEvent (`detail: {id, entry, mount}`)
// on selecting a catalog entry — the shell listens for this ONCE at its own
// root rather than this component knowing how to navigate anywhere itself
// (same separation qu-profile-card/qu-people-search already use). `entry`/
// `mount` are passed through exactly as the catalog declared them (either
// can be undefined) — qu-app-shell.mjs's own listener decides which one to
// act on (mount preferred, entry as fallback/redirect).

import { visibleCatalogEntries, sortCatalog, footerEntries, resolveFavoriteEntries } from './nav-catalog.mjs';
import { findQu } from '../src/ui/components.js';

const FALLBACK_ICON = '\u{1F4E6}'; // package emoji — a visible placeholder, not a blank/broken-looking icon
const APP_DIRECTORY_ID = 'app-directory';
const ADMIN_ID = 'relay-admin';

export class QuNavDropdownElement extends HTMLElement {
  connectedCallback() {
    this._catalog = [];
    this._favoriteIds = [];
    this._isAdmin = false;
    this._offFavorites = null;
    this._render(); // an immediate first render (empty state) — _load()'s async fetches fill it in shortly after, same "show something now, refine once data arrives" stance as every other async-bootstrapped Qu-Component here
    this._load();
    this._onDocClick = (e) => { if (!this.contains(e.target)) this._close(); };
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._onDocClick);
    this._offFavorites?.();
    this._offFavorites = null;
  }

  async _load() {
    const qu = findQu(this);
    if (!qu) { console.error('[qu-nav-dropdown] no ancestor .qu found — favorites/admin-link stay unavailable'); return; }

    fetch('/relay/services')
      .then((res) => res.json())
      .then((all) => { this._catalog = all; this._render(); })
      .catch((e) => console.error('[qu-nav-dropdown] failed to load /relay/services:', e));

    // Purely a UI convenience, NOT a security check — same stance as
    // qu-app-shell.mjs's own _revealAdminLinkIfAdmin() (see its doc): a
    // real unauthorized write still fails at the relay's own ACL either
    // way, this only decides whether to show the Admin-Portal link.
    fetch('/relay/info')
      .then((res) => res.json())
      .then((info) => { this._isAdmin = (info.admins ?? []).includes(qu.fingerprint); this._render(); })
      .catch((e) => console.error('[qu-nav-dropdown] failed to load /relay/info:', e));

    this._offFavorites = qu.onFavoritesChange((q) => {
      const appId = q.id.slice(q.id.lastIndexOf('/') + 1);
      this._favoriteIds = q.value == null
        ? this._favoriteIds.filter((id) => id !== appId)
        : [...this._favoriteIds.filter((id) => id !== appId), appId];
      this._render();
    });
  }

  _render() {
    // Absent (fresh mount, nothing rendered yet) must default to CLOSED —
    // `!undefined?.hidden` would otherwise evaluate to `true` and open the
    // menu on the very first render, before anyone ever clicked anything.
    const priorMenu = this.querySelector('.qu-nav-dropdown-menu');
    const wasOpen = priorMenu ? !priorMenu.hidden : false;
    this.textContent = '';

    const favorites = sortCatalog(resolveFavoriteEntries(this._catalog, this._favoriteIds));
    const appDirectory = this._catalog.find((s) => s.id === APP_DIRECTORY_ID && (s.entry || s.mount) && s.enabled !== false);
    const admin = this._isAdmin ? this._catalog.find((s) => s.id === ADMIN_ID && (s.entry || s.mount) && s.enabled !== false) : null;
    const footer = sortCatalog(footerEntries(this._catalog));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'qu-nav-dropdown-toggle';
    toggle.textContent = '⚙️ Apps';

    const menu = document.createElement('ul');
    menu.className = 'qu-nav-dropdown-menu';
    menu.hidden = !wasOpen; // re-render (e.g. a live favorites change) must not silently close an already-open menu

    if (favorites.length === 0 && !appDirectory && !admin && footer.length === 0) {
      toggle.disabled = true;
      toggle.title = 'Noch keine Apps verfügbar';
      this.append(toggle);
      const hint = document.createElement('p');
      hint.className = 'qu-nav-dropdown-empty-hint';
      hint.textContent = 'Noch keine Apps verfügbar.';
      this.append(hint);
      return;
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    const addItem = (entry) => {
      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'qu-nav-dropdown-item';
      item.textContent = `${entry.icon ?? FALLBACK_ICON} ${entry.label}`;
      item.addEventListener('click', () => {
        this._close();
        this.dispatchEvent(new CustomEvent('qu-app-select', { detail: { id: entry.id, entry: entry.entry, mount: entry.mount }, bubbles: true }));
      });
      li.appendChild(item);
      menu.appendChild(li);
    };
    const addHeading = (text) => {
      const heading = document.createElement('li');
      heading.className = 'qu-nav-dropdown-category';
      heading.textContent = text;
      menu.appendChild(heading);
    };

    if (favorites.length > 0) {
      addHeading('⭐ Favoriten');
      for (const entry of favorites) addItem(entry);
    }
    if (appDirectory) addItem(appDirectory);
    if (admin) addItem(admin);

    if (footer.length > 0) {
      const divider = document.createElement('li');
      divider.className = 'qu-nav-dropdown-divider';
      menu.appendChild(divider);
      let currentCategory = null;
      for (const entry of footer) {
        if (entry.category !== currentCategory) { currentCategory = entry.category; addHeading(currentCategory); }
        addItem(entry);
      }
    }

    this.append(toggle, menu);
  }

  _close() {
    const menu = this.querySelector('.qu-nav-dropdown-menu');
    if (menu) menu.hidden = true;
  }
}

if (!customElements.get('qu-nav-dropdown')) customElements.define('qu-nav-dropdown', QuNavDropdownElement);
