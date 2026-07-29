// `<qu-contact-star>` — a small, self-contained "add/remove as contact"
// toggle button for ONE fingerprint, built on src/modules/contacts.js's
// already-tested API (createContactsPlugin(), installed shell-wide) — the
// same "wrap an existing Qu-core module as a reusable Qu-Component" shape
// ui/profile-components.js's `<qu-profile-card>` already uses for
// modules/profiles.js.
//
// Deliberately its own Custom Element (not just a callback returning a
// plain button) so it manages its own qu.onContactsChange() subscription
// through the normal connectedCallback()/disconnectedCallback() lifecycle —
// a caller embedding many of these in a list (see
// ui/people-search-components.js's `rowActions` extension point below)
// never has to track/unsubscribe them itself: removing the element from
// the DOM (e.g. a search result list re-rendering on every keystroke)
// cleans it up automatically, the same guarantee every other Qu-Component
// here already gives.
//
// Attributes:
//   fp   Required — the fingerprint to star/unstar as a contact.
//
// Which Qu instance: same non-global resolution as every other Qu-Component
// here — see ui/components.js's findQu().
//
// Styling: unstyled by default (a plain `<button>`, classed
// `qu-contact-star`) — a host app's own stylesheet decides how it looks,
// same "no framework opinion on visuals" stance as every other Qu-Component.

import { findQu } from './components.js';

export class QuContactStarElement extends HTMLElement {
  static get observedAttributes() { return ['fp']; }

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
      else console.error('[qu-contact-star] no Qu instance found — set .qu on this element or an ancestor', this);
      return;
    }
    const fp = this.getAttribute('fp');
    if (!fp) { console.error('[qu-contact-star] missing required "fp" attribute', this); return; }

    this.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'qu-contact-star';
    this.appendChild(btn);

    let isContact = false;
    const render = () => {
      btn.textContent = isContact ? '⭐' : '☆';
      btn.title = isContact ? 'Aus Kontakten entfernen' : 'Als Kontakt hinzufügen';
    };
    render();

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (isContact) await qu.removeContact(fp);
        else await qu.addContact(fp);
      } catch (e) {
        console.error('[qu-contact-star] toggle failed:', e);
      } finally {
        btn.disabled = false;
      }
    });

    // qu.onContactsChange() reports every contact's changes, not just this
    // one fp's — filtered here rather than adding a per-fp query variant to
    // modules/contacts.js for a single UI convenience; see that module's
    // own doc for `q.id`'s last path segment being the contact fingerprint.
    this._off = qu.onContactsChange((q) => {
      const contactFp = q.id.slice(q.id.lastIndexOf('/') + 1);
      if (contactFp !== fp) return;
      isContact = q.value != null;
      render();
    });
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }
}

if (!customElements.get('qu-contact-star')) customElements.define('qu-contact-star', QuContactStarElement);
