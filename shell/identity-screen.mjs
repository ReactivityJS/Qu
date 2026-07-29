// The `~<fp>`/`u/<fp>` screen — a plain render function, not a Custom
// Element: unlike qu-nav-dropdown.mjs (a generic, independently reusable
// display primitive) this screen is entirely owned by qu-app-shell.mjs's
// own route dispatch, which already knows `fingerprint` and re-renders on
// every route change — same "plain function, not a component" precedent
// Qu's own examples/people/app.mjs uses for its profile-view modal. Less
// lifecycle ceremony (no observedAttributes/connectedCallback), same
// testability (none — DOM-only, verified via a real browser, see the
// Phase 1 plan's own verification section).

import { isValidFingerprint, DIRECTORY_ID, buildPath } from '../src/index.js';
import { canShare, shareContent } from '../src/ui/share.mjs';
import { isPushSupported, getExistingSubscription, subscribeToPush, unsubscribeFromPush } from '../src/ui/push.mjs';
import '../src/ui/components.js'; // Seiteneffekt: registriert <qu-view>/<qu-bind> (renderAttributesEditor()/renderAvatarEditor() unten) — bisher nur zufällig schon von shell/qu-nav-dropdown.mjs's eigenem Import mitregistriert, hier jetzt explizit, da diese Datei sie selbst direkt verwendet.

/**
 * Renders into `container` (cleared first). `qu` is the shell's shared,
 * already-connected Qu instance (see qu-app-shell.mjs) — this function
 * assumes `container` lives inside `qu-app-shell`'s own subtree, so any
 * `<qu-profile-card>` it appends resolves `.qu` via the normal findQu()
 * walk-up with zero extra wiring.
 */
export function renderIdentityView(container, { qu, fingerprint, repl, swRegistration, vapidPublicKey }) {
  container.textContent = '';

  if (!isValidFingerprint(fingerprint)) {
    const err = document.createElement('p');
    err.className = 'qu-identity-error';
    err.textContent = `Ungültiger Fingerprint: "${fingerprint}"`;
    container.appendChild(err);
    return;
  }

  const card = document.createElement('qu-profile-card');
  card.setAttribute('fp', fingerprint);

  const fpLine = document.createElement('p');
  fpLine.className = 'qu-identity-fp';
  const fpCode = document.createElement('code');
  fpCode.textContent = fingerprint;
  fpLine.append('Fingerprint: ', fpCode);

  const shareSection = renderShareButton(fingerprint);

  const appsHeading = document.createElement('h3');
  appsHeading.textContent = 'Apps';
  const appsList = document.createElement('ul');
  appsList.className = 'qu-identity-apps';

  container.append(card, fpLine, shareSection, appsHeading, appsList);

  const isOwn = fingerprint === qu.fingerprint;
  if (isOwn) {
    container.appendChild(renderAliasEditor(qu));
    container.appendChild(renderAvatarEditor(qu));
    container.appendChild(renderVisibilityToggle(qu));
    container.appendChild(renderPushToggle(qu, { repl, swRegistration, vapidPublicKey }));
    container.appendChild(renderAttributesEditor(qu));
  } else {
    container.appendChild(renderAddContactButton(qu, fingerprint));
    container.appendChild(renderAttributesReadOnly(qu, fingerprint));
  }

  renderAppParticipation(qu, fingerprint, appsList);
}

/**
 * A "Teilen" button for THIS profile's link — shown for any fingerprint
 * being viewed (own or someone else's), since "share this profile's link"
 * makes sense regardless of whose identity it is. Uses qu-core/src/ui/
 * share.mjs's generic shareContent() — the concrete, real, permanent
 * consumer that proves the helper actually works end-to-end, not a
 * speculative "for later" import.
 */
function renderShareButton(fingerprint) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qu-identity-share';
  btn.textContent = canShare() ? '📤 Teilen' : '📋 Link kopieren';

  const status = document.createElement('span');
  status.className = 'qu-identity-share-status';
  status.hidden = true;

  btn.addEventListener('click', async () => {
    const url = `${location.origin}${location.pathname}${buildPath(`~${fingerprint}`)}`;
    btn.disabled = true;
    try {
      const result = await shareContent({ title: 'QUniverse-Profil', text: fingerprint, url });
      if (result === 'copied') {
        status.textContent = 'Link kopiert.';
        status.hidden = false;
      } else if (result === 'unsupported') {
        status.textContent = `Teilen nicht unterstützt — Link: ${url}`;
        status.hidden = false;
      }
      // 'shared'/'cancelled'/'noop' need no extra status — the OS share
      // sheet itself was the feedback, or there was nothing to say.
    } catch (e) {
      console.error('[identity-screen] share failed:', e);
      status.textContent = 'Teilen fehlgeschlagen.';
      status.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  const wrap = document.createElement('p');
  wrap.className = 'qu-identity-share-wrap';
  wrap.append(btn, status);
  return wrap;
}

/**
 * Own-profile-only alias editor — `Qu#publishProfile({alias})` (src/qu.js)
 * always re-writes `pub`/`epub` alongside `alias` in the same call, which
 * is harmless here (both are deterministic re-exports of this identity's
 * OWN already-loaded keys, not a second identity change smuggled in), so
 * this stays the one, already-documented write path rather than a new
 * alias-only primitive. Every `<qu-profile-card>` showing this fingerprint
 * anywhere in the shell updates live on its own once this lands (that
 * component's own `.on('alias')` subscription, ui/profile-components.js) —
 * this function only needs to update ITS OWN input's placeholder/value
 * after a successful save, nothing else.
 */
function renderAliasEditor(qu) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-identity-alias-edit';
  const label = document.createElement('label');
  label.textContent = 'Alias';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 64;
  input.disabled = true; // enabled once the current alias has actually loaded — never save blind over an unknown current value
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.textContent = 'Speichern';
  saveBtn.disabled = true;
  const status = document.createElement('span');
  status.className = 'qu-identity-alias-status';
  wrap.append(label, input, saveBtn, status);

  // Same two-part shape renderVisibilityToggle() below uses, and for the
  // identical reason: `qu.readProfile()`/`qu.get()` are pure LOCAL reads
  // (see session.js's own doc — "qu.get(id) never does I/O by itself").
  // After a fresh page load this session's local store is EMPTY of
  // everything except the identity keys themselves (session-bootstrap.js's
  // own "everything else uses a fresh MemoryAdapter" doc), so a one-shot
  // read alone would show the fallback (the fingerprint itself) forever —
  // only a live `.on()` subscription, which (registered while a
  // connection is already active) itself triggers the real network fetch
  // via subscribeDispatch, ever brings the ACTUAL current alias back. The
  // `document.activeElement !== input` guard is this field's own addition
  // (renderVisibilityToggle's checkbox needs no such guard, an atomic
  // click has nothing to clobber): a live update must never overwrite an
  // in-progress, not-yet-saved edit while the user is still typing.
  const path = `~${qu.fingerprint}`;
  qu.get(path).get('alias').then((q) => {
    if (document.activeElement !== input) input.value = q?.value ?? qu.fingerprint;
    input.disabled = false;
    saveBtn.disabled = false;
  }).catch((e) => { console.error('[identity-screen] initial alias read failed:', e); input.disabled = false; saveBtn.disabled = false; });
  qu.get(path).get('alias').on((q) => {
    if (document.activeElement !== input) input.value = q?.value ?? qu.fingerprint;
  });

  saveBtn.addEventListener('click', async () => {
    const alias = input.value.trim();
    if (!alias) { status.textContent = 'Alias darf nicht leer sein.'; return; }
    saveBtn.disabled = true;
    status.textContent = '';
    try {
      await qu.publishProfile({ alias });
      status.textContent = 'Gespeichert.';
    } catch (e) {
      console.error('[identity-screen] publishProfile(alias) failed:', e);
      status.textContent = `Fehlgeschlagen: ${e.message}`;
    } finally {
      saveBtn.disabled = false;
    }
  });

  return wrap;
}

/**
 * Own-profile-only avatar editor — a plain (not encrypted) leaf QuBit at
 * `~<fp>/avatar`, same public visibility as `alias` (any `<qu-profile-card>`
 * showing this fingerprint anywhere already renders it live, see
 * ui/profile-components.js's own `.on()` subscription — no separate wiring
 * needed for it to show up elsewhere the moment it's saved here). A real
 * `<qu-bind>` for the URL input AND a real `<qu-view>` for the live
 * preview — no manual get()/on()/put() plumbing at all, both Qu-Components
 * do the entire round trip on their own.
 */
function renderAvatarEditor(qu) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-identity-avatar-edit';
  const label = document.createElement('label');
  label.textContent = 'Avatar-URL ';
  const bind = document.createElement('qu-bind');
  bind.setAttribute('path', `~${qu.fingerprint}`);
  bind.setAttribute('key', 'avatar');
  bind.setAttribute('attr', 'value');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'https://…/bild.png';
  bind.appendChild(input);
  label.appendChild(bind);

  const preview = document.createElement('qu-view');
  preview.setAttribute('path', `~${qu.fingerprint}`);
  preview.setAttribute('key', 'avatar');
  preview.setAttribute('attr', 'src');
  const img = document.createElement('img');
  img.className = 'qu-identity-avatar-preview';
  img.alt = '';
  preview.appendChild(img);

  wrap.append(label, preview);
  return wrap;
}

/**
 * Shown only for someone ELSE's profile (never your own — see the
 * isOwn/else split in renderIdentityView() above): the one place in the
 * shell that actually calls `qu.addContact()`/`qu.removeContact()`
 * (services/contacts/app.mjs's own list is the other consumer, same
 * plugin, same private per-identity list — see src/modules/contacts.js's
 * file doc for why this is never published anywhere, unlike the
 * visibility toggle above). One-shot `listContacts()` read to decide the
 * button's initial "add" vs. "remove" label — same "never toggle blind"
 * stance as renderVisibilityToggle()/renderPushToggle() above.
 */
function renderAddContactButton(qu, fingerprint) {
  const wrap = document.createElement('p');
  wrap.className = 'qu-identity-contact';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.disabled = true;
  wrap.appendChild(btn);

  function setLabel(isContact) {
    btn.dataset.isContact = String(isContact);
    btn.textContent = isContact ? '📇 Aus Kontakten entfernen' : '📇 Zu Kontakten hinzufügen';
  }

  qu.listContacts().then((contacts) => {
    setLabel(contacts.some((c) => c.fingerprint === fingerprint));
    btn.disabled = false;
  }).catch((e) => { console.error('[identity-screen] initial listContacts failed:', e); btn.disabled = false; setLabel(false); });
  // Same reasoning as renderAliasEditor()'s own doc comment: listContacts()
  // alone is a one-shot LOCAL read, blind to this identity's OWN
  // contacts list as stored at the relay until something actually asks
  // the network for it — this live subscription (src/modules/contacts.js's
  // onContactsChange()) is that ask, filtered down to just the ONE
  // fingerprint this button cares about.
  qu.onContactsChange((q) => {
    if (q.id.slice(q.id.lastIndexOf('/') + 1) !== fingerprint) return;
    setLabel(q.value != null);
    btn.disabled = false;
  });

  btn.addEventListener('click', async () => {
    const wasContact = btn.dataset.isContact === 'true';
    btn.disabled = true;
    try {
      if (wasContact) await qu.removeContact(fingerprint);
      else await qu.addContact(fingerprint);
      setLabel(!wasContact);
    } catch (e) {
      console.error('[identity-screen] add/removeContact failed:', e);
    } finally {
      btn.disabled = false;
    }
  });

  return wrap;
}

function renderVisibilityToggle(qu) {
  const wrap = document.createElement('label');
  wrap.className = 'qu-identity-visibility';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = true; // enabled once the current state has actually loaded — never toggle blind
  wrap.append(checkbox, ' Im Verzeichnis sichtbar (öffentlich auffindbar)');

  // Same two-part shape src/ui/profile-components.js's own doc comment
  // documents: `.on()` alone only ever reports FUTURE changes (no
  // `initial: true`, see core/subscribe-with-options.js) — and even
  // `initial: true` wouldn't help for a path that doesn't exist YET (the
  // catch-up query simply finds nothing, no callback fires either way,
  // see that file's own `for (const q of existing) callback(q)` loop). So:
  // one explicit one-shot read for the CURRENT state (enables the checkbox
  // either way, visible or not, existing or not), then a plain live `.on()`
  // for whatever changes from here on (including from another tab/device).
  const path = `${DIRECTORY_ID}/entries/${qu.fingerprint}`;
  qu.get(path).then((q) => {
    checkbox.checked = !!q?.value?.visible;
    checkbox.disabled = false;
  }).catch((e) => { console.error('[identity-screen] initial directory-visibility read failed:', e); checkbox.disabled = false; });
  qu.get(path).on((q) => { checkbox.checked = !!q?.value?.visible; });

  checkbox.addEventListener('change', () => {
    checkbox.disabled = true;
    qu.setDirectoryVisible(checkbox.checked)
      .catch((e) => { console.error('[identity-screen] setDirectoryVisible failed:', e); })
      .finally(() => { checkbox.disabled = false; });
  });

  return wrap;
}

/**
 * The own-profile-only "enable notifications" toggle — real, permanent
 * consumer of qu-core/src/ui/push.mjs, the platform-level push mechanism
 * ANY app on this deployment gets for free via modules/notifications.js's
 * createNotificationPushRule() (see QUniverse's own server.mjs). Same
 * checkbox shape as renderVisibilityToggle() above, disabled until the
 * CURRENT subscription state has actually loaded (never toggle blind).
 *
 * `repl`/`swRegistration`/`vapidPublicKey` all come from qu-app-shell.mjs's
 * own bootstrap and can each still be `null`/undefined at render time
 * (still connecting, no Service Worker support, push disabled server-side)
 * — every one of those is a disabled-with-explanation state, never a
 * crash or a silently non-functional checkbox.
 */
function renderPushToggle(qu, { repl, swRegistration, vapidPublicKey }) {
  const wrap = document.createElement('label');
  wrap.className = 'qu-identity-push';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.disabled = true;
  const labelText = document.createElement('span');
  labelText.textContent = ' Push-Benachrichtigungen aktiviert';
  wrap.append(checkbox, labelText);

  const hint = document.createElement('span');
  hint.className = 'qu-identity-push-hint';
  wrap.appendChild(hint);

  if (!isPushSupported()) {
    hint.textContent = ' (von diesem Browser nicht unterstützt)';
    return wrap;
  }
  if (!vapidPublicKey) {
    hint.textContent = ' (auf diesem Relay deaktiviert)';
    return wrap;
  }
  if (!swRegistration || !repl) {
    hint.textContent = ' (verbindet …)';
    return wrap;
  }

  getExistingSubscription(swRegistration).then((sub) => {
    checkbox.checked = !!sub;
    checkbox.disabled = false;
  }).catch((e) => { console.error('[identity-screen] initial push-subscription read failed:', e); checkbox.disabled = false; });

  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    hint.textContent = '';
    try {
      if (checkbox.checked) {
        await subscribeToPush(qu, repl, swRegistration, vapidPublicKey);
      } else {
        await unsubscribeFromPush(qu, repl, swRegistration);
      }
    } catch (e) {
      console.error('[identity-screen] push toggle failed:', e);
      checkbox.checked = !checkbox.checked; // revert — the attempted change did not actually take effect
      hint.textContent = ` (fehlgeschlagen: ${e.message})`;
    } finally {
      checkbox.disabled = false;
    }
  });

  return wrap;
}

/**
 * The value control for one attribute row — three cases:
 *   - `!editable` (someone else's profile, always plain — see
 *     renderAttrRow()'s own doc for why a private attribute can never
 *     even reach this far for a non-owner viewer): a plain read-only span.
 *   - `editable && !entry.private`: a REAL `<qu-bind>` (src/ui/components.js)
 *     around a `contenteditable` span — the Qu-Component does the entire
 *     read+live-update+write dance on its own, no manual event wiring at
 *     all, editing on blur/input exactly like any other `<qu-bind>`.
 *   - `editable && entry.private`: `<qu-bind>` is NOT used here — its
 *     underlying `bindKey()` (src/ui/bindings.js) writes via a bare
 *     `node.put(value)`, no `encryptFor` option at all, so saving an
 *     already-private attribute through it would silently STRIP its
 *     encryption on the very next edit. This mirrors `<qu-bind>`'s own
 *     shape by hand (contenteditable, write on blur, skip an unchanged
 *     value) but adds the one thing it can't do: re-encrypting on every
 *     write, via `qu.setProfileAttr(key, value, {encryptFor:[qu.fingerprint]})`.
 */
function buildValueElement(qu, key, entry, editable) {
  if (!editable) {
    const span = document.createElement('span');
    span.className = 'qu-identity-attrs-value';
    span.textContent = String(entry.value);
    return span;
  }
  if (!entry.private) {
    const bind = document.createElement('qu-bind');
    bind.className = 'qu-identity-attrs-value';
    bind.setAttribute('path', `~${qu.fingerprint}`);
    bind.setAttribute('key', `attrs/${key}`);
    bind.setAttribute('attr', 'textContent');
    const span = document.createElement('span');
    span.contentEditable = 'true';
    bind.appendChild(span);
    return bind;
  }
  const span = document.createElement('span');
  span.className = 'qu-identity-attrs-value';
  span.contentEditable = 'true';
  span.textContent = String(entry.value);
  let lastValue = span.textContent;
  span.addEventListener('blur', async () => {
    const value = span.textContent;
    if (value === lastValue) return;
    const previous = lastValue;
    lastValue = value;
    try {
      await qu.setProfileAttr(key, value, { encryptFor: [qu.fingerprint] });
    } catch (e) {
      console.error('[identity-screen] inline edit (private attribute) failed:', e);
      lastValue = previous;
      span.textContent = previous;
    }
  });
  return span;
}

/**
 * Shared row-rendering for both renderAttributesEditor() (own profile,
 * `editable: true`) and renderAttributesReadOnly() (someone else's,
 * `editable: false`) below — same `rows` Map (key -> <li>, so a live
 * update patches the existing row instead of rebuilding the whole list).
 *
 * A row, once created, is deliberately NEVER rebuilt again while its key
 * still exists — only removed (tombstone) or left alone. The value
 * control itself (a live `<qu-bind>`, or the private-attribute span's own
 * blur handler above) already keeps ITSELF current; tearing the whole
 * `<li>` down and recreating it on every live event — as an earlier
 * version of this function did — would blow away whatever the user is
 * CURRENTLY typing the moment any unrelated attribute event arrives
 * (`onProfileAttrsChange()` fires for every key, not just this one).
 *
 * A private attribute is ALWAYS shown with its real, decrypted value —
 * never a "🔒 (privat)" placeholder that hides it even from its own
 * owner: `entry.private` only reaches this far at all because THIS
 * caller already successfully decrypted it (session.js's own doc: a
 * qubit only reports `encrypted: true` on a SUCCESSFUL decrypt too, not
 * just on failure). On someone else's profile, `entry.private` can only
 * ever be `false` in the first place — `listProfileAttrs()`'s own doc
 * explains why: a field encrypted to someone ELSE (not the caller) fails
 * to decrypt, `q.value` stays `undefined`, and `listProfileAttrs()`
 * already filters that out before this ever runs. There is deliberately
 * no separate server-side "is this public" check to duplicate — the SAME
 * encryption that hides a private attribute from a relay operator already
 * hides it from a non-owner viewer here, for free, not a UI-level access
 * check that could be bypassed. The 🔒 badge below is purely informational
 * (own view only: "this one is hidden from everyone else"), never a
 * value-hiding device.
 */
function renderAttrRow(qu, list, rows, key, entry, { editable = false, onDelete } = {}) {
  const existing = rows.get(key);
  if (entry == null) { existing?.remove(); rows.delete(key); return; }
  if (existing) return; // already rendered — see doc above for why nothing here needs refreshing

  const li = document.createElement('li');
  rows.set(key, li);
  list.appendChild(li);

  const keyEl = document.createElement('code');
  keyEl.textContent = key;
  li.append(keyEl, ': ', buildValueElement(qu, key, entry, editable));
  if (entry.private) {
    const lock = document.createElement('span');
    lock.className = 'qu-identity-attrs-lock';
    lock.title = 'Privat — nur für dich sichtbar (verschlüsselt)';
    lock.textContent = ' 🔒';
    li.appendChild(lock);
  }
  if (onDelete) {
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '✕';
    delBtn.title = `"${key}" löschen`;
    delBtn.addEventListener('click', () => onDelete(delBtn));
    li.appendChild(delBtn);
  }
}

/**
 * Own-profile-only custom-attribute editor — the UI for
 * src/modules/profiles.js's `setProfileAttr()`/`deleteProfileAttr()`/
 * `listProfileAttrs()`/`onProfileAttrsChange()` (already installed as
 * `qu.*` sugar by createProfilesPlugin(), same as renderVisibilityToggle()
 * above uses `qu.setDirectoryVisible`). "privat" in the UI means
 * `encryptFor: [qu.fingerprint]` — encrypted-to-self, same mechanism
 * every other private field in this codebase uses (modules/contacts.js's
 * own doc calls this out explicitly): readable by THIS identity from any
 * of ITS OWN devices/sessions, unreadable by anyone else, including a
 * relay operator with full storage access. A plain (non-private)
 * attribute is readable by anyone who can read this identity's Space at
 * all — same default as alias/avatar.
 *
 * Live via `onProfileAttrsChange()` rather than a one-shot list — an
 * add/edit/delete from ANOTHER of this identity's own devices/tabs
 * updates this list without a manual refresh, same reactive stance as
 * every other `.on()`/`.map()` subscription in this file.
 */
function renderAttributesEditor(qu) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-identity-attrs';
  const heading = document.createElement('h3');
  heading.textContent = 'Eigene Attribute';
  const list = document.createElement('ul');
  list.className = 'qu-identity-attrs-list';
  wrap.append(heading, list);

  const rows = new Map();
  const renderRow = (key, entry) => renderAttrRow(qu, list, rows, key, entry, {
    editable: true,
    onDelete: (btn) => {
      btn.disabled = true;
      qu.deleteProfileAttr(key).catch((e) => { console.error('[identity-screen] deleteProfileAttr failed:', e); btn.disabled = false; });
    },
  });

  // Same two-part shape as every other reactive read in this file (see
  // renderAliasEditor()'s own doc comment for the full reasoning): a
  // one-shot `listProfileAttrs()` for whatever's already known, PLUS the
  // live `onProfileAttrsChange()` below for both future changes and — via
  // network/index.js's catch-up sync now replaying every known topic to
  // each newly connected repl — the CURRENT value too, even if this
  // specific subscription registers before any connection exists yet.
  qu.listProfileAttrs(qu.fingerprint).then((attrs) => {
    for (const [key, entry] of Object.entries(attrs)) renderRow(key, entry);
  }).catch((e) => console.error('[identity-screen] initial listProfileAttrs failed:', e));
  // `q.value === null` on a live event is the tombstone shape
  // (deleteProfileAttr()'s own doc) — `entry` built here matches
  // listProfileAttrs()'s own `{value, private}` shape so renderRow() has
  // one consistent input either way.
  qu.onProfileAttrsChange(qu.fingerprint, (q) => {
    const key = q.id.slice(q.id.lastIndexOf('/') + 1);
    renderRow(key, q.value == null ? null : { value: q.value, private: !!q.encrypted });
  });

  const form = document.createElement('div');
  form.className = 'qu-identity-attrs-form';
  const keyInput = document.createElement('input');
  keyInput.type = 'text';
  keyInput.placeholder = 'Schlüssel';
  keyInput.maxLength = 64;
  const valueInput = document.createElement('input');
  valueInput.type = 'text';
  valueInput.placeholder = 'Wert';
  const privateLabel = document.createElement('label');
  const privateCheckbox = document.createElement('input');
  privateCheckbox.type = 'checkbox';
  privateLabel.append(privateCheckbox, ' privat (nur für mich, verschlüsselt)');
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.textContent = 'Hinzufügen';
  const status = document.createElement('span');
  status.className = 'qu-identity-attrs-status';
  form.append(keyInput, valueInput, privateLabel, addBtn, status);
  wrap.appendChild(form);

  addBtn.addEventListener('click', async () => {
    const key = keyInput.value.trim();
    const value = valueInput.value;
    if (!key) { status.textContent = 'Schlüssel darf nicht leer sein.'; return; }
    addBtn.disabled = true;
    status.textContent = '';
    try {
      await qu.setProfileAttr(key, value, privateCheckbox.checked ? { encryptFor: [qu.fingerprint] } : undefined);
      keyInput.value = '';
      valueInput.value = '';
      privateCheckbox.checked = false;
    } catch (e) {
      console.error('[identity-screen] setProfileAttr failed:', e);
      status.textContent = `Fehlgeschlagen: ${e.message}`;
    } finally {
      addBtn.disabled = false;
    }
  });

  return wrap;
}

/**
 * Read-only counterpart to renderAttributesEditor() above, for viewing
 * someone ELSE's profile — same reactive plumbing (one-shot
 * `listProfileAttrs()` + live `onProfileAttrsChange()`, same shared
 * `renderAttrRow()`), just no delete button and no add-form. Never shows
 * anything empty-but-misleading: `wrap` (heading included) only gets
 * attached to the DOM once at least one attribute has actually arrived —
 * a fingerprint with zero public attributes shows nothing extra at all,
 * same "never fabricate placeholder content" stance as
 * renderAppParticipation() below already documents for its own empty case.
 */
function renderAttributesReadOnly(qu, fingerprint) {
  const wrap = document.createElement('div');
  wrap.className = 'qu-identity-attrs';
  wrap.hidden = true;
  const heading = document.createElement('h3');
  heading.textContent = 'Attribute';
  const list = document.createElement('ul');
  list.className = 'qu-identity-attrs-list';
  wrap.append(heading, list);

  const rows = new Map();
  const renderRow = (key, entry) => {
    renderAttrRow(qu, list, rows, key, entry);
    wrap.hidden = rows.size === 0;
  };

  qu.listProfileAttrs(fingerprint).then((attrs) => {
    for (const [key, entry] of Object.entries(attrs)) renderRow(key, entry);
  }).catch((e) => console.error('[identity-screen] initial listProfileAttrs (read-only) failed:', e));
  qu.onProfileAttrsChange(fingerprint, (q) => {
    const key = q.id.slice(q.id.lastIndexOf('/') + 1);
    renderRow(key, q.value == null ? null : { value: q.value, private: !!q.encrypted });
  });

  return wrap;
}

/**
 * Documented ecosystem convention (see src/modules/README.md's
 * notifications.js entry / Phase 0 design doc): an app writes
 * `app-<appId>` (a profiles.js custom attribute, same storage as every
 * other attribute above) the first time a user meaningfully participates.
 * No app in QUniverse writes this yet, so this is HONESTLY empty today
 * for every fingerprint — never fabricated placeholder content. Live via
 * `onProfileAttrsChange()`, same one-shot + live pairing as every other
 * reactive read in this file (see renderAliasEditor()'s own doc comment
 * for the full reasoning) — a one-shot read alone would show "Noch keine
 * Apps." forever if this specific subscription happened to register
 * before this session had a connection yet.
 */
function renderAppParticipation(qu, fingerprint, listEl) {
  const rows = new Map(); // appId -> <li>, same patch-not-rebuild shape as renderAttrRow() above
  const empty = document.createElement('li');
  empty.className = 'qu-identity-apps-empty';
  empty.textContent = 'Noch keine Apps.';
  listEl.appendChild(empty);

  function renderRow(appId, present) {
    let li = rows.get(appId);
    if (!present) { li?.remove(); rows.delete(appId); }
    else if (!li) {
      li = document.createElement('li');
      li.textContent = appId;
      rows.set(appId, li);
      listEl.appendChild(li);
    }
    empty.hidden = rows.size > 0;
  }

  qu.listProfileAttrs(fingerprint).then((attrs) => {
    for (const key of Object.keys(attrs)) {
      if (key.startsWith('app-')) renderRow(key.slice('app-'.length), true);
    }
  }).catch((e) => console.error('[identity-screen] initial listProfileAttrs (apps) failed:', e));
  qu.onProfileAttrsChange(fingerprint, (q) => {
    const key = q.id.slice(q.id.lastIndexOf('/') + 1);
    if (key.startsWith('app-')) renderRow(key.slice('app-'.length), q.value != null);
  });
}
