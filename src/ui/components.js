// Qu Components: declarative Custom Elements over ui/bindings.js's
// viewKey()/bindKey() — the DOM-mount-lifecycle counterpart to those plain
// functions. `<qu-view>` subscribes in connectedCallback() and unsubscribes
// in disconnectedCallback() — exactly what every Lab section was already
// doing by hand (mountXxxView() returning an unmount closure); this makes
// that wiring automatic instead of imperative.
//
// Deliberately BROWSER-ONLY (extends HTMLElement at module-evaluation
// time — importing this in Node throws immediately) — same reason
// adapters/node-fs.js is kept out of src/index.js's barrel, just for the
// opposite platform. Import it directly wherever it's used:
//   import '../../../src/ui/components.js';   // side-effect: registers the tags
//   import { QuViewElement, QuBindElement } from '../../../src/ui/components.js';
//
// Two elements, not four — "as many as necessary, as few as possible":
// <qu-bind> IS a <qu-view> plus write-back, implemented as a one-method
// subclass, not a second mechanism.
//
// There is deliberately no separate "object" element either. A record with
// several independently-writable properties is the same "each field its
// own leaf QuBit" shape bindObject() already uses (see bindings.js) — kept
// there specifically so two people editing different fields never collide
// on one LWW register — expressed here as N <qu-view>/<qu-bind> siblings
// sharing one `path` prefix, each with its own `key`:
//
//   <div data-qu-root>                       (see "Which Qu instance" below)
//     <qu-view path="alice/profile" key="name"></qu-view>
//     <qu-bind path="alice/profile" key="bio" contenteditable="true"></qu-bind>
//   </div>
//
// Attributes (all optional except `path`):
//   path    Required. The QuBit id — or, if `key` is set, the id PREFIX.
//   key     Optional. If set, the bound id becomes `${path}/${key}` (its
//           own leaf QuBit) rather than `path` itself — this is what turns
//           a single element into one field of a multi-property record.
//   attr    Which DOM attribute/property carries the value:
//             "value"        form controls (input/textarea/select)
//             "textContent"  plain text (works with contenteditable)
//             "innerHTML"    rich content (works with contenteditable)
//             "checked"      checkboxes/radios (write-back event: "change")
//             anything else  a generic HTML attribute (href, src, class,
//                             data-*, ...), read/written via get/setAttribute
//           Default ("auto", or omitted): the same value-if-present-else-
//           textContent heuristic bindKey() itself already defaults to —
//           the common case needs no `attr` at all.
//
// Target element: a plain `<qu-view>`/`<qu-bind>` acts on ITSELF (fine for
// textContent/innerHTML/contenteditable, or a generic attribute set
// directly on the tag). Wrap a single real form control — or any element —
// as its one child, and that child becomes the target instead, so a real
// <input>/<textarea>/<select>/<img>/<a> is actually driven, without ever
// needing `is="..."` customized built-ins (which Safari doesn't support):
//
//   <qu-bind path="alice/profile" key="name" attr="value"><input></qu-bind>
//   <qu-view path="alice/profile" key="avatar" attr="src"><img></qu-view>
//
// Which Qu instance: never a global. Set `.qu` as a plain property on the
// element itself, or on any ancestor (including across a shadow-root
// boundary) — findQu() below walks up looking for it, so one assignment on
// a container covers every descendant <qu-view>/<qu-bind>. Because
// appendChild() runs connectedCallback() synchronously, `container.qu = qu`
// must happen BEFORE the qu-view/qu-bind children are appended into it —
// if it's missing at mount time, one microtask retry covers the common
// "appended, then wired up next line" ordering before giving up for real.

import { viewKey, bindKey, DEFAULT_ELEMENT_IO } from './bindings.js';

function findQu(el) {
  let node = el;
  while (node) {
    if (node.qu) return node.qu;
    node = node.parentNode || node.host || null;
  }
  return null;
}

function resolveTarget(el) {
  return el.children.length === 1 ? el.children[0] : el;
}

function resolveIO(attrName) {
  if (!attrName || attrName === 'auto') return DEFAULT_ELEMENT_IO;
  if (attrName === 'checked') {
    return { get: (el) => el.checked, set: (el, v) => { el.checked = !!v; }, event: 'change' };
  }
  if (attrName === 'value' || attrName === 'textContent' || attrName === 'innerHTML') {
    return { get: (el) => el[attrName], set: (el, v) => { el[attrName] = v ?? ''; }, event: 'input' };
  }
  return {
    get: (el) => el.getAttribute(attrName),
    set: (el, v) => { if (v == null) el.removeAttribute(attrName); else el.setAttribute(attrName, String(v)); },
    event: 'input',
  };
}

export class QuViewElement extends HTMLElement {
  static get observedAttributes() { return ['path', 'key', 'attr']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._unmount();
    this._mount();
  }

  _mount(isRetry = false) {
    const qu = findQu(this);
    if (!qu) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error(`[${this.tagName.toLowerCase()}] no Qu instance found — set .qu on this element or an ancestor`, this);
      return;
    }
    const path = this.getAttribute('path');
    if (!path) { console.error(`[${this.tagName.toLowerCase()}] missing required "path" attribute`, this); return; }
    const key = this.getAttribute('key');
    const fullPath = key ? `${path}/${key}` : path;
    const target = resolveTarget(this);
    const io = resolveIO(this.getAttribute('attr'));
    this._off = this._start(qu, fullPath, target, io);
  }

  _unmount() {
    this._off?.();
    this._off = null;
  }

  _start(qu, fullPath, target, { set }) {
    return viewKey(qu, fullPath, (value) => set(target, value));
  }
}

export class QuBindElement extends QuViewElement {
  _start(qu, fullPath, target, { get, set, event }) {
    return bindKey(qu, fullPath, target, {
      get, set, event,
      onError: (e) => this.dispatchEvent(new CustomEvent('qu-error', { detail: e, bubbles: true })),
    });
  }
}

if (!customElements.get('qu-view')) customElements.define('qu-view', QuViewElement);
if (!customElements.get('qu-bind')) customElements.define('qu-bind', QuBindElement);
