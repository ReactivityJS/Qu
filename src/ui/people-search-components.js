// `<qu-people-search>` — a search bar + result list over the global
// identity directory (modules/profiles.js), built on top of
// `<qu-profile-card>` (ui/profile-components.js) for the actual rendering
// of each result: this component only decides WHICH fingerprints to show,
// never how one looks.
//
// Deliberately BROWSER-ONLY, same reason as ui/components.js/
// ui/profile-components.js. Import it directly wherever it's used:
//   import '.../src/ui/people-search-components.js';   // registers the tag
//
//   <qu-people-search mode="browse"></qu-people-search>
//   <qu-people-search mode="search" fields="alias,fingerprint" href="#/{fp}"></qu-people-search>
//
// Two modes (the "2 Varianten" a directory search bar needs):
//   mode="browse"  (default) Shows the FULL current directory immediately,
//                  the input just narrows it as you type — for a
//                  "browse everyone, then narrow down" screen (see
//                  examples/people, the directory root).
//   mode="search"  Shows NOTHING until a query is typed, then shows only
//                  matches — for a "find one specific person" picker
//                  embedded inside another flow (see examples/chat's
//                  add-contact screen), where preloading/rendering the
//                  entire directory would be noise, not help.
//
// Fingerprint matching is a PREFIX match (`startsWith`), not a substring
// search — a fingerprint is an ID, not free text; typing its first few
// characters (like a shortened git hash) is the expected, non-secret way
// to address someone directly (see modules/profiles.js's directory doc:
// the fingerprint itself is never the secret, only whether the identity
// chose to be visible/listed at all). This ALREADY covers a full 24-
// character fingerprint as a special case of "prefix of itself" — plus,
// either mode additionally shows a result for a query that is itself a
// COMPLETE valid fingerprint (core/identity.js's isValidFingerprint()),
// even if that identity isn't (or isn't yet) visible in the opt-in
// directory at all: whoever already knows the full fingerprint may
// address it directly, the same "paste a known fingerprint" path every
// app that predates this component already had, just folded into the
// same search box instead of a separate raw-fp input field. A mere
// PREFIX of an identity that isn't in the directory still won't resolve
// anything — there is no reverse index from a partial id to a full one
// without a directory entry to match against, by design (no centralized
// registry). Alias matching stays a substring search (`includes`) — free
// text, a mid-string hit ("lice" finding "Alice") is expected there. Set
// the `fields` attribute without `fingerprint` to turn fingerprint
// matching off entirely (alias-only search, e.g. a "browse people I might
// know" screen that shouldn't also double as a raw-fingerprint lookup
// tool).
//
// Attributes:
//   mode         "browse" | "search" (default "browse", see above).
//   fields       Comma-separated list of which entry fields the built-in
//                text matcher checks — "alias", "fingerprint", or both
//                (default). Set el.matchFn = (entry, query) => boolean
//                (a plain property, not an attribute — a function can't
//                be one) to search anything else (e.g. a custom profile
//                attribute via modules/profiles.js's getProfileAttr()) —
//                `entry` is `{ fingerprint, alias }`; `fields` is ignored
//                once matchFn is set.
//   href         Forwarded verbatim to every rendered <qu-profile-card>'s
//                own `href` attribute (its `{fp}` templating, see
//                ui/profile-components.js) — omit to instead only listen
//                for `qu-profile-open` events bubbling up from the cards.
//   placeholder  Input placeholder text.
//
// Which Qu instance: same non-global resolution as every other
// Qu-Component here — see ui/components.js's findQu(); set `.qu` on this
// element or an ancestor.
//
// Fires `qu-people-search-results` (bubbling, `detail: { count, query }`)
// after every render, for a host that wants to show "3 Treffer" or an
// empty-state message itself instead of relying on `list.children.length`.
//
// Styling: unstyled by default — `qu-people-search-input`/
// `qu-people-search-results` classed elements, a host stylesheet decides
// how they look, same stance as ui/profile-components.js.

import { findQu } from './components.js';
import { isValidFingerprint } from '../core/identity.js';
import './profile-components.js'; // Seiteneffekt: registriert <qu-profile-card>

const DEFAULT_FIELDS = ['alias', 'fingerprint'];

export class QuPeopleSearchElement extends HTMLElement {
  static get observedAttributes() { return ['mode', 'fields', 'href', 'placeholder']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  /** Self-cleaning, same reason as QuViewElement._mount() in ui/components.js — see its doc comment. */
  _mount(isRetry = false) {
    this._unmount();
    const qu = findQu(this);
    if (!qu) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error('[qu-people-search] no Qu instance found — set .qu on this element or an ancestor', this);
      return;
    }

    const mode = this.getAttribute('mode') === 'search' ? 'search' : 'browse';
    const fields = (this.getAttribute('fields') ?? DEFAULT_FIELDS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
    const hrefTemplate = this.getAttribute('href');

    this.textContent = '';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'qu-people-search-input';
    input.placeholder = this.getAttribute('placeholder') ?? (mode === 'search' ? 'Suchen …' : 'Filtern …');
    const list = document.createElement('ul');
    list.className = 'qu-people-search-results';
    this.append(input, list);

    // `entries`/`aliasCache` existieren NUR für die Textsuche selbst — die
    // eigentliche Anzeige (Avatar, aktueller Alias) macht jede
    // <qu-profile-card> unten komplett eigenständig reaktiv, unabhängig
    // davon, ob dieser Cache gerade aktuell ist.
    let entries = []; // [{ fingerprint }] — modules/profiles.js's listDirectory()
    const aliasCache = new Map(); // fp -> alias
    const aliasUnsubs = new Map(); // fp -> unsub, nur solange der Eintrag noch im Verzeichnis ist

    // Fingerprint: `startsWith`, nicht `includes` — ein Fingerprint ist
    // eine ID, kein Fließtext; die ersten paar Zeichen einzutippen (wie
    // ein gekürzter Git-Hash) ist der erwartete, nicht-geheime Weg, jemand
    // Bestimmten zu adressieren (siehe modules/profiles.js's Verzeichnis-
    // Doku: der Fingerprint selbst ist nie das Geheimnis, nur ob die
    // Identität überhaupt sichtbar/im Verzeichnis ist). Alias bleibt
    // `includes` — freier Text, ein Treffer irgendwo in der Mitte ist dort
    // sinnvoll ("lice" soll "Alice" finden).
    const defaultMatch = (entry, query) => fields.some((f) => {
      if (f === 'fingerprint') return entry.fingerprint.toLowerCase().startsWith(query);
      if (f === 'alias') return (entry.alias ?? '').toLowerCase().includes(query);
      return false;
    });

    const render = () => {
      const raw = input.value.trim();
      const q = raw.toLowerCase();
      const withAlias = () => entries.map((e) => ({ fingerprint: e.fingerprint, alias: aliasCache.get(e.fingerprint) ?? e.fingerprint }));
      let results;
      if (!q) {
        results = mode === 'browse' ? withAlias() : [];
      } else {
        const matcher = this.matchFn ?? defaultMatch;
        results = withAlias().filter((e) => matcher(e, q));
        if (fields.includes('fingerprint') && isValidFingerprint(raw) && !results.some((e) => e.fingerprint === q)) {
          results = [{ fingerprint: q, alias: q }, ...results];
        }
      }
      results = results.slice().sort((a, b) => a.alias.localeCompare(b.alias) || a.fingerprint.localeCompare(b.fingerprint));

      list.textContent = '';
      for (const r of results) {
        const li = document.createElement('li');
        const card = document.createElement('qu-profile-card');
        card.setAttribute('fp', r.fingerprint);
        if (hrefTemplate) card.setAttribute('href', hrefTemplate);
        li.appendChild(card);
        list.appendChild(li);
      }
      this.dispatchEvent(new CustomEvent('qu-people-search-results', { detail: { count: results.length, query: raw }, bubbles: true }));
    };

    async function refresh() {
      entries = await qu.listDirectory();
      const currentFps = new Set(entries.map((e) => e.fingerprint));
      for (const fp of [...aliasUnsubs.keys()]) {
        if (!currentFps.has(fp)) { aliasUnsubs.get(fp)?.(); aliasUnsubs.delete(fp); aliasCache.delete(fp); }
      }
      for (const { fingerprint: fp } of entries) {
        if (aliasUnsubs.has(fp)) continue;
        // Kein initial:true nötig (siehe ui/profile-components.js — derselbe
        // Trick): das bloße Registrieren eines .on() löst über qu.connect()s
        // globalen subscribeDispatch (network/index.js) den eigentlichen
        // Netzwerk-Sync von selbst aus; der aktuelle Wert kommt dann als
        // ganz normaler Ingest hier an, kein separates repl.sync() nötig.
        aliasUnsubs.set(fp, qu.get(`~${fp}`).get('alias').on((q) => { aliasCache.set(fp, q?.value ?? fp); render(); }));
      }
      render();
    }

    input.addEventListener('input', render);
    const offDirectory = qu.onDirectoryChange(() => refresh());
    this._off = () => {
      offDirectory();
      for (const off of aliasUnsubs.values()) off();
      aliasUnsubs.clear();
    };
    refresh();
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }
}

if (!customElements.get('qu-people-search')) customElements.define('qu-people-search', QuPeopleSearchElement);
