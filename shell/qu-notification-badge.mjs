// `<qu-notification-badge>` — the ecosystem's one central inbox feed,
// rendered as a header badge+dropdown (same UI shape as
// `<qu-nav-dropdown>`, not a full-page overlay — a small, transient
// affordance, not a "page" this ecosystem's routing convention otherwise
// reserves real navigation for).
//
// Merges TWO already-existing, generic Qu-core reactive feeds that both
// live under the same per-identity `inbox-<fp>` id (qu-core's own
// src/modules/notifications.js's doc comment already anticipates this
// exact merge):
//   - `onNotification(qu, cb)` — a generic "something happened" feed any
//     app can write to via `qu.notifyUser(fp, {appId, kind, message,
//     contentRef})` (also the platform-level push hook — see
//     src/modules/notifications.js's createNotificationPushRule()).
//   - `onSpaceInvite(qu, cb)` — "you were invited to a Space" (a Space
//     owner/member calling `notifyMembers()`), a structurally different
//     but adjacent mailbox subtree (`requests/` vs. `notifications/`).
//
// Unread tracking is DEVICE-LOCAL only (a plain `localStorage` timestamp,
// keyed by fingerprint) — deliberately not synced: "have I looked at my
// inbox on THIS device" is exactly the kind of per-device UI state
// src/ui/session-bootstrap.js's own `getOrCreateDeviceId()` doc already
// treats as local, not a QuBit worth replicating.
//
// Light DOM only, no attachShadow() — same qu-profile-open/qu-people-
// search-results bubbling-event constraint qu-app-shell.mjs's own doc
// comment explains; this component doesn't fire either of those itself,
// but living inside qu-app-shell's own light-DOM tree, a shadow root here
// would still needlessly break `findQu()`'s parentNode/host walk-up for
// nothing this component needs.

import { onNotification, onSpaceInvite, buildPath } from '../src/index.js';
import { findQu } from '../src/ui/components.js';

const LAST_SEEN_PREFIX = 'qu-inbox-last-seen-';
const MAX_SHOWN = 20; // a dropdown, not a full inbox page — most-recent slice only, oldest still reachable by re-navigating (no pagination UI in this phase)

function lastSeenKey(fingerprint) { return `${LAST_SEEN_PREFIX}${fingerprint}`; }

function getLastSeen(fingerprint) {
  return Number(localStorage.getItem(lastSeenKey(fingerprint))) || 0;
}

function setLastSeen(fingerprint, ts) {
  localStorage.setItem(lastSeenKey(fingerprint), String(ts));
}

/**
 * `contentRef` is an app-defined, UNENFORCED convention (src/modules/
 * notifications.js's own doc: "e.g. `{appId, spaceId, path}`") — this
 * function is deliberately permissive about its actual shape, since any
 * app calling `qu.notifyUser()` decides its own `contentRef` today:
 *   - a plain string -> treated as a literal hash path already (`#/...`
 *     or without the leading `#`, either works via `location.hash =`).
 *   - an object -> `buildPath(spaceId ?? appId, path)`, `path` omitted if
 *     absent (an object with neither `spaceId` nor `appId` navigates
 *     nowhere — falls through to the inbox home below instead of
 *     throwing on a malformed convention from a caller this component
 *     doesn't control).
 */
function hashForContentRef(contentRef) {
  if (typeof contentRef === 'string' && contentRef) return contentRef.startsWith('#') ? contentRef : `#${contentRef}`;
  const spaceId = contentRef?.spaceId ?? contentRef?.appId;
  if (!spaceId) return null;
  return contentRef.path ? buildPath(spaceId, contentRef.path) : buildPath(spaceId);
}

export class QuNotificationBadgeElement extends HTMLElement {
  connectedCallback() {
    this._items = new Map(); // key -> {ts, kind:'notification'|'invite', label, hash}, de-duplicated by the underlying QuBit's own id
    this._offs = [];
    this._menuOpen = false;
    this._render();

    const qu = findQu(this);
    if (!qu) { console.error('[qu-notification-badge] no ancestor .qu found — not rendering'); return; }
    this._qu = qu;

    this._offs.push(onNotification(qu, (q) => this._handleNotification(q)));
    this._offs.push(onSpaceInvite(qu, (q) => this._handleInvite(q)));

    this._onDocClick = (e) => { if (!this.contains(e.target)) this._close(); };
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    this._offs.forEach((off) => off?.());
    this._offs = [];
    document.removeEventListener('click', this._onDocClick);
  }

  _handleNotification(q) {
    if (q.value == null) { this._items.delete(q.id); this._render(); return; } // tombstone — never produced today, but never assumed away either
    const { kind, message, contentRef, fromFp } = q.value;
    this._items.set(q.id, {
      ts: q.ts,
      label: message || `Neue Aktivität (${kind || 'unbekannt'}) von ${(fromFp || '').slice(0, 10)}…`,
      hash: hashForContentRef(contentRef),
    });
    this._render();
  }

  _handleInvite(q) {
    if (q.value == null) { this._items.delete(q.id); this._render(); return; }
    const { fromFp, id: spaceId } = q.value;
    this._items.set(q.id, {
      ts: q.ts,
      label: `Einladung von ${(fromFp || '').slice(0, 10)}… zu einem Space`,
      hash: spaceId ? buildPath(spaceId) : null,
    });
    this._render();
  }

  _sortedItems() {
    return [...this._items.values()].sort((a, b) => b.ts - a.ts);
  }

  _render() {
    this.textContent = '';
    const items = this._sortedItems();
    // Open/closed is this component's OWN state (`this._menuOpen`, not
    // implicit DOM state on a specific `<ul>` element) precisely because
    // `_render()` rebuilds the whole subtree from scratch on every new
    // notification/invite — a live event arriving while the dropdown is
    // open must not silently close it again by discarding the old,
    // already-`hidden=false` element and replacing it with a fresh,
    // default-hidden one.
    const menuOpen = this._menuOpen ?? false;
    const lastSeen = this._qu ? getLastSeen(this._qu.fingerprint) : 0;
    const unread = items.filter((it) => it.ts > lastSeen).length;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'qu-notification-toggle';
    toggle.textContent = unread > 0 ? `🔔 ${unread > 99 ? '99+' : unread}` : '🔔';
    toggle.title = 'Benachrichtigungen';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !this._menuOpen;
      this._menuOpen = opening;
      if (opening && this._qu) setLastSeen(this._qu.fingerprint, Date.now());
      this._render();
    });

    const menu = document.createElement('ul');
    menu.className = 'qu-notification-menu';
    menu.hidden = !menuOpen;

    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'qu-notification-empty';
      empty.textContent = 'Keine Benachrichtigungen.';
      menu.appendChild(empty);
    }
    for (const item of items.slice(0, MAX_SHOWN)) {
      const li = document.createElement('li');
      const el = item.hash ? document.createElement('a') : document.createElement('span');
      el.className = 'qu-notification-item';
      if (item.hash) el.href = item.hash;
      el.textContent = item.label;
      li.appendChild(el);
      menu.appendChild(li);
    }

    this.append(toggle, menu);
  }

  _close() {
    if (!this._menuOpen) return;
    this._menuOpen = false;
    this._render();
  }
}

if (!customElements.get('qu-notification-badge')) customElements.define('qu-notification-badge', QuNotificationBadgeElement);
