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
// Attributes:
//   path    The QuBit id — or, if `key` is set, the id PREFIX. Required,
//           UNLESS the current `.qu` context itself has an `.id` (a
//           QuSpace), in which case an omitted `path` defaults to that
//           context's own id — see <qu-list> below, where this is what
//           lets a <template>'s fields skip repeating the item's id.
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
//
// `.qu` doesn't have to be a Qu instance — anything duck-typed the same way
// works, in particular a QuSpace (core/space-handle.js: qu.own/qu.space(id)):
// `container.qu = alice.own` scopes every descendant's `path` relative to
// that Space instead of the whole store. This is what <qu-list> below uses
// to give each stamped item its own relative context automatically.
//
// <qu-list path="..."> is the declarative form of viewObject() — one
// <template> child, cloned once per child QuBit under `path`, each clone's
// `.qu` set to `qu.space(<that item's own id>)` so <qu-view>/<qu-bind>
// elements *inside* the template can address that item's fields with a
// plain `key`, no id math:
//
//   <qu-list path="alice/todos">
//     <template>
//       <li>
//         <qu-view key="text"></qu-view>
//         <qu-bind key="done" attr="checked"><input type="checkbox"></qu-bind>
//       </li>
//     </template>
//   </qu-list>
//
// This only covers the common "record = several leaf QuBits" shape — the
// same one bindObject()/<qu-view key>/<qu-bind key> already assume
// elsewhere (see class doc above). An item whose fields live in ONE
// combined QuBit value (not leaf-per-field), or that needs to follow a
// key://\file:// reference to render, has no purely-declarative answer here
// — use viewObject() directly for that (see docs/lab/labs/
// 05-references-practice.mjs, which does exactly this for its category/
// avatar fields while its plain leaf fields could use <qu-list>). There is
// still only one list/collection primitive underneath either way — this is
// its declarative face, not a second mechanism.

import { viewKey, bindKey, viewObject, DEFAULT_ELEMENT_IO } from './bindings.js';

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
    this._mount();
  }

  /**
   * Always tears down any previous mount before building a fresh one —
   * NOT just when the caller already knows one exists. Parsing an element
   * straight from HTML markup with its attributes already present (as
   * opposed to createElement()+setAttribute()+appendChild()) can fire
   * attributeChangedCallback() for those initial attributes while
   * isConnected is ALREADY true, i.e. BEFORE connectedCallback() itself
   * runs — both then call _mount(), and without this, that meant two
   * independent subscriptions (and, for <qu-list>, two stamped copies of
   * every item). Self-cleaning here means the order/count of calls no
   * longer matters — the last one always wins cleanly.
   */
  _mount(isRetry = false) {
    this._unmount();
    const qu = findQu(this);
    if (!qu) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error(`[${this.tagName.toLowerCase()}] no Qu instance found — set .qu on this element or an ancestor`, this);
      return;
    }
    // `path` may be omitted if the current .qu context has its own `.id`
    // (a QuSpace, e.g. one <qu-list> stamped per item via qu.space(itemId))
    // — omitted then means "let that context resolve `key` itself", so a
    // <template> full of <qu-view key="...">/<qu-bind key="..."> never has
    // to repeat the item's id at all. A plain Qu instance has no `.id`, so
    // `path` stays required there exactly as before.
    //
    // NOT the same as building `${qu.id}/${key}` here and handing THAT to
    // qu.on()/qu.publish() — a QuSpace resolves whatever it's given
    // relative to itself already, so pre-resolving here too would prefix
    // qu.id twice. Whenever `path` IS given, on the other hand, it's handed
    // through as-is: a plain Qu ignores relative resolution entirely (its
    // `on()`/`publish()` never do it — unchanged, tested behavior), while a
    // QuSpace context resolves an explicit `path` relative to itself
    // exactly once, same as it would for `key` alone.
    const pathAttr = this.getAttribute('path');
    const key = this.getAttribute('key');
    let fullPath;
    if (pathAttr !== null) {
      fullPath = key ? `${pathAttr}/${key}` : pathAttr;
    } else if (qu.id !== undefined) {
      fullPath = key ?? '';
    } else {
      console.error(`[${this.tagName.toLowerCase()}] missing "path" attribute (and the current .qu context has no implicit id to fall back to)`, this);
      return;
    }
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

/**
 * Declarative form of viewObject() — see the class doc above for the
 * <template>-based shape and its scope (leaf-per-field items only).
 */
export class QuListElement extends HTMLElement {
  static get observedAttributes() { return ['path']; }

  connectedCallback() { this._mount(); }
  disconnectedCallback() { this._unmount(); }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue || !this.isConnected) return;
    this._mount();
  }

  /** Self-cleaning, same reason as QuViewElement._mount() — see its doc comment. */
  _mount(isRetry = false) {
    this._unmount();
    const qu = findQu(this);
    if (!qu) {
      if (!isRetry) queueMicrotask(() => { if (this.isConnected && !this._off) this._mount(true); });
      else console.error('[qu-list] no Qu instance found — set .qu on this element or an ancestor', this);
      return;
    }
    const path = this.getAttribute('path');
    if (!path) { console.error('[qu-list] missing required "path" attribute', this); return; }
    const template = this.querySelector('template');
    if (!template) { console.error('[qu-list] missing a <template> child to stamp per item', this); return; }

    // Matches leaf fields at any depth under an item, not just direct
    // children of `path` — an item exists the moment ANY of its fields is
    // written, no separate "root" QuBit at `${path}/<itemId>` itself
    // required. `itemIdOf()` extracts just the item's own id segment from
    // whichever leaf field happened to be seen (first, for a brand new
    // item; on every subsequent write, for grouping).
    const itemIdOf = (qubitId) => qubitId.slice(path.length + 1).split('/')[0];

    this._off = viewObject(qu, path, {
      pattern: `${path}/**`,
      key: (q) => itemIdOf(q.id),
      createItem: (q) => {
        const itemId = `${path}/${itemIdOf(q.id)}`;
        const clone = template.content.cloneNode(true);
        const roots = [...clone.children];
        for (const el of roots) el.qu = qu.space(itemId); // each item's own fields, relative to its own id — see class doc
        this.appendChild(clone);
        return roots;
      },
      // Leaf-per-field items render themselves — each <qu-view>/<qu-bind>
      // inside the template already subscribes on its own. Nothing to do
      // here for the shape <qu-list> targets (see class doc for the case
      // where this ISN'T enough).
      render() {},
    });
  }

  _unmount() {
    this._off?.();
    this._off = null;
    for (const child of [...this.children]) {
      if (child.tagName !== 'TEMPLATE') child.remove();
    }
  }
}

if (!customElements.get('qu-view')) customElements.define('qu-view', QuViewElement);
if (!customElements.get('qu-bind')) customElements.define('qu-bind', QuBindElement);
if (!customElements.get('qu-list')) customElements.define('qu-list', QuListElement);
