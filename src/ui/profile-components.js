// `<qu-profile-card>` — the "global profile template" a chat, a forum, a
// ToDo list, or anything else can drop in to show ANY identity's
// avatar+alias with zero per-app wiring: no per-app alias-cache, no
// per-app avatar-subscription, no per-app "read once, then hope someone
// remembers to keep it live" bookkeeping (see examples/chat/app.mjs's
// aliasFor()/avatarFor()/ensureRoom()'s live `.on()` subscriptions before
// this existed — this component is that same pattern, generalized once
// instead of reimplemented by every app that shows an identity).
//
// Deliberately BROWSER-ONLY (extends HTMLElement at module-evaluation
// time — importing this in Node throws immediately), same reason as
// ui/components.js. Import it directly wherever it's used:
//   import '../../../src/ui/profile-components.js';   // side-effect: registers the tag
//
//   <qu-profile-card fp="<fingerprint>"></qu-profile-card>
//
// Attributes:
//   fp    Whose identity to show. Optional — omitted falls back to the
//         current `.qu` context's OWN fingerprint (so
//         `<qu-profile-card></qu-profile-card>` under `container.qu = qu`
//         renders "my own" card with no attribute at all).
//   href  Optional link template — `{fp}` is replaced with the (URL-
//         encoded) fingerprint, e.g. `href="#/{fp}"`. Given, the card
//         renders as an `<a>`; omitted, a plain `<span>`. Either way a
//         click always additionally dispatches a bubbling
//         `qu-profile-open` CustomEvent with `detail: { fingerprint }`,
//         so a host app can navigate through its OWN router (see
//         examples/people/app.mjs) instead of being forced into the
//         `href` templating for anything more elaborate.
//   show-fp  Boolean (present = on). Appends the fingerprint itself
//         (classed `qu-profile-fp`, a `<code>`) after the alias — for a
//         list where telling two same-alias identities apart matters
//         (e.g. services/directory's people search), not needed for a
//         single card shown alone (the header, a chat message).
//
// Which Qu instance: same non-global resolution as ui/components.js's
// `<qu-view>`/`<qu-bind>` — see findQu() there, reused here as-is (never a
// module-level singleton; set `.qu` on this element or an ancestor).
//
// Styling: unstyled by default (a plain `<img>`/`<span>`, classed
// `qu-profile-avatar`/`qu-profile-alias` inside a
// `qu-profile-card`-classed root) — a host app's own stylesheet decides
// how it looks, same "no framework opinion on visuals" stance as every
// other Qu-Component.

import { findQu } from './components.js';

export class QuProfileCardElement extends HTMLElement {
  static get observedAttributes() { return ['fp', 'href', 'show-fp']; }

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
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._offs) this._mount(true); });
      else console.error('[qu-profile-card] no Qu instance found — set .qu on this element or an ancestor', this);
      return;
    }
    const fp = this.getAttribute('fp') ?? qu.fingerprint;
    if (!fp) {
      console.error('[qu-profile-card] missing "fp" attribute (and the current .qu context has no fingerprint to fall back to — a guest session?)', this);
      return;
    }

    this.textContent = '';
    const hrefTemplate = this.getAttribute('href');
    const root = document.createElement(hrefTemplate ? 'a' : 'span');
    root.className = 'qu-profile-card';
    if (hrefTemplate) root.href = hrefTemplate.replace('{fp}', encodeURIComponent(fp));

    const avatarEl = document.createElement('img');
    avatarEl.className = 'qu-profile-avatar';
    avatarEl.hidden = true;
    avatarEl.alt = '';

    const nameEl = document.createElement('span');
    nameEl.className = 'qu-profile-alias';
    nameEl.textContent = fp;

    root.append(avatarEl, nameEl);
    if (this.hasAttribute('show-fp')) {
      const fpEl = document.createElement('code');
      fpEl.className = 'qu-profile-fp';
      fpEl.textContent = fp;
      root.appendChild(fpEl);
    }
    this.appendChild(root);

    root.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('qu-profile-open', { detail: { fingerprint: fp }, bubbles: true }));
    });

    // Initial resolve — `.on()` below only ever reports FUTURE changes
    // (core/space-handle.js's on()-doc, no `initial: true` like map()),
    // so the current value needs its own one-shot read, same two-part
    // shape as examples/chat/app.mjs's aliasFor()/avatarFor() before this
    // component existed.
    qu.readProfile(fp).then((p) => { if (this.isConnected) nameEl.textContent = p.alias; }).catch(() => {});
    qu.get(`~${fp}/avatar`).then((q) => this._setAvatar(avatarEl, q?.value ?? null)).catch(() => {});

    this._offs = [
      qu.get(`~${fp}`).get('alias').on((q) => { if (q?.value) nameEl.textContent = q.value; }),
      qu.get(`~${fp}`).get('avatar').on((q) => this._setAvatar(avatarEl, q?.value ?? null)),
    ];
  }

  _setAvatar(avatarEl, url) {
    if (!this.isConnected) return;
    avatarEl.hidden = !url;
    avatarEl.src = url ?? '';
  }

  _unmount() {
    for (const off of this._offs ?? []) off();
    this._offs = null;
  }
}

if (!customElements.get('qu-profile-card')) customElements.define('qu-profile-card', QuProfileCardElement);
