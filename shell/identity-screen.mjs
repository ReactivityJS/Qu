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
    container.appendChild(renderVisibilityToggle(qu));
    container.appendChild(renderPushToggle(qu, { repl, swRegistration, vapidPublicKey }));
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

async function renderAppParticipation(qu, fingerprint, listEl) {
  let attrs = {};
  try {
    attrs = await qu.listProfileAttrs(fingerprint);
  } catch (e) {
    console.error('[identity-screen] listProfileAttrs failed:', e);
  }
  if (!listEl.isConnected) return;

  // Documented ecosystem convention (see src/modules/README.md's
  // notifications.js entry / Phase 0 design doc): an app writes
  // `app-<appId>` the first time a user meaningfully participates. No app
  // in QUniverse writes this yet, so this is HONESTLY empty today for
  // every fingerprint — never fabricated placeholder content.
  const appKeys = Object.keys(attrs).filter((k) => k.startsWith('app-'));
  if (appKeys.length === 0) {
    const li = document.createElement('li');
    li.className = 'qu-identity-apps-empty';
    li.textContent = 'Noch keine Apps.';
    listEl.appendChild(li);
    return;
  }
  for (const key of appKeys) {
    const li = document.createElement('li');
    li.textContent = key.slice('app-'.length);
    listEl.appendChild(li);
  }
}
