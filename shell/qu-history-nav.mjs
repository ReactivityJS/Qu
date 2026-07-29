// `<qu-history-nav>` — Zurück/Vorwärts + eine Dropdown-Sprungliste der
// zuletzt besuchten Seiten. Back/Forward sind einfach `history.back()`/
// `history.forward()` — jede Navigation in dieser Shell ist bereits ein
// echter `location.hash = ...`-Wechsel (kein `history.replaceState()`
// irgendwo), der Browser führt also schon einen korrekten Verlaufs-Stack;
// dieses Element erfindet dafür nichts neu. Die Sprungliste dagegen braucht
// eigene Buchführung — `window.history` hat keine API, um bereits
// besuchte Einträge aufzulisten (history-nav.mjs's eigener Datei-Kommentar).
//
// Unabhängig vom Router der Shell selbst verdrahtet (eigener
// `createWindowHashSource()` + `decideRoute()`-Aufruf, eigener
// `/relay/services`-Fetch) — dieselbe "kein gemeinsamer Cache, Einfachheit
// vor Abstraktion ohne zweiten echten Aufrufer"-Haltung, die
// qu-nav-dropdown.mjs schon für genau denselben Fetch dokumentiert.
//
// Ein Sprungziel-Eintrag vom `kind:'identity'` (siehe history-nav.mjs) hat
// bewusst kein statisches Label — eine rohe Fingerprint sagt einem Menschen
// nichts. Stattdessen wird jeder solche Eintrag als eine echte, kleine
// `<qu-profile-card>` gerendert (braucht `.qu`, siehe findQu() unten) —
// dieselbe reaktive Alias-Auflösung, die jede andere Profilanzeige in
// dieser Shell schon verwendet, statt eine eigene Alias-Cache-Kopie zu
// pflegen.
//
// Light DOM, kein attachShadow() — gleiche Begründung wie
// qu-app-shell.mjs/qu-nav-dropdown.mjs: `qu-profile-open` (von
// `<qu-profile-card>`) ist `bubbles:true`, aber NICHT `composed:true`.

import { decideRoute, createRouter } from '../src/ui/router.js';
import { createWindowHashSource } from '../src/ui/router-browser.js';
import { describeDecision, recordVisit } from './history-nav.mjs';
import { findQu } from '../src/ui/components.js';
import '../src/ui/profile-components.js'; // Seiteneffekt: registriert <qu-profile-card>

export class QuHistoryNavElement extends HTMLElement {
  connectedCallback() {
    this._entries = [];
    this._services = undefined;
    this._render();

    fetch('/relay/services')
      .then((res) => res.json())
      .then((services) => { this._services = services; this._router?.setServices(services); })
      .catch((e) => console.error('[qu-history-nav] failed to load /relay/services:', e));

    this._router = createRouter({ ...createWindowHashSource(), services: this._services });
    this._router.onRoute((decision) => {
      const entry = describeDecision(decision, this._services ?? []);
      const next = recordVisit(this._entries, entry);
      if (next !== this._entries) { this._entries = next; this._render(); }
    });
    this._stopRouter = this._router.start();

    this._onDocClick = (e) => { if (!this.contains(e.target)) this._close(); };
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    this._stopRouter?.();
    document.removeEventListener('click', this._onDocClick);
  }

  _close() {
    const menu = this.querySelector('.qu-history-nav-menu');
    if (menu) menu.hidden = true;
  }

  _render() {
    const priorMenu = this.querySelector('.qu-history-nav-menu');
    const wasOpen = priorMenu ? !priorMenu.hidden : false; // absent (first render) must default to CLOSED — see qu-nav-dropdown.mjs's own identical fix for why
    this.textContent = '';

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'qu-history-nav-back';
    back.title = 'Zurück';
    back.textContent = '◀';
    back.addEventListener('click', () => history.back());

    const forward = document.createElement('button');
    forward.type = 'button';
    forward.className = 'qu-history-nav-forward';
    forward.title = 'Vorwärts';
    forward.textContent = '▶';
    forward.addEventListener('click', () => history.forward());

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'qu-history-nav-toggle';
    toggle.title = 'Verlauf';
    toggle.textContent = '🕘';
    toggle.disabled = this._entries.length === 0;

    const menu = document.createElement('ul');
    menu.className = 'qu-history-nav-menu';
    menu.hidden = !wasOpen;

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });

    // Most-recent-first in the dropdown (recordVisit() itself appends
    // most-recent-LAST, the natural order for a growing log) — a "jump
    // back" list reads better with the CURRENT page at the top.
    for (const entry of [...this._entries].reverse()) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.className = 'qu-history-nav-item';
      link.href = entry.hash;
      link.addEventListener('click', () => this._close());
      if (entry.kind === 'identity') {
        const card = document.createElement('qu-profile-card');
        card.setAttribute('fp', entry.fingerprint);
        card.setAttribute('show-fp', '');
        link.appendChild(card);
      } else {
        link.textContent = `${entry.icon} ${entry.label}`;
      }
      li.appendChild(link);
      menu.appendChild(li);
    }

    this.append(back, forward, toggle, menu);
  }
}

if (!customElements.get('qu-history-nav')) customElements.define('qu-history-nav', QuHistoryNavElement);
