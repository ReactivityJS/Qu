// `<qu-nav-dropdown>` — the ecosystem's app catalog, rendered as a
// dropdown menu. Deliberately has NO `.qu` dependency at all (unlike every
// other Qu-Component this shell composes) — it only ever reads the public,
// unauthenticated `/relay/services` catalog (server/service-registry.mjs's
// `toJSON()`), never Space content.
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

import { visibleCatalogEntries, sortCatalog } from './nav-catalog.mjs';

const FALLBACK_ICON = '\u{1F4E6}'; // package emoji — a visible placeholder, not a blank/broken-looking icon

export class QuNavDropdownElement extends HTMLElement {
  connectedCallback() {
    this._load();
    this._onDocClick = (e) => { if (!this.contains(e.target)) this._close(); };
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    document.removeEventListener('click', this._onDocClick);
  }

  async _load() {
    this.textContent = '';
    let entries = [];
    try {
      const res = await fetch('/relay/services');
      const all = await res.json();
      entries = sortCatalog(visibleCatalogEntries(all));
    } catch (e) {
      console.error('[qu-nav-dropdown] failed to load /relay/services:', e);
    }
    if (!this.isConnected) return;
    this._render(entries);
  }

  _render(entries) {
    this.textContent = '';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'qu-nav-dropdown-toggle';

    const menu = document.createElement('ul');
    menu.className = 'qu-nav-dropdown-menu';
    menu.hidden = true;

    if (entries.length === 0) {
      toggle.textContent = '⚙️ Apps';
      toggle.disabled = true;
      toggle.title = 'Noch keine Apps verfügbar';
      this.append(toggle);
      const hint = document.createElement('p');
      hint.className = 'qu-nav-dropdown-empty-hint';
      hint.textContent = 'Noch keine Apps verfügbar.';
      this.append(hint);
      return;
    }

    toggle.textContent = '⚙️ Apps';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    let currentCategory = null;
    for (const entry of entries) {
      if (entry.category !== currentCategory) {
        currentCategory = entry.category;
        const heading = document.createElement('li');
        heading.className = 'qu-nav-dropdown-category';
        heading.textContent = currentCategory;
        menu.appendChild(heading);
      }
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
    }

    this.append(toggle, menu);
  }

  _close() {
    const menu = this.querySelector('.qu-nav-dropdown-menu');
    if (menu) menu.hidden = true;
  }
}

if (!customElements.get('qu-nav-dropdown')) customElements.define('qu-nav-dropdown', QuNavDropdownElement);
