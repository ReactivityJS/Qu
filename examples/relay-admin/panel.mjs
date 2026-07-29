// Shared admin-panel wiring — the ONE implementation both the standalone
// page (app.mjs: its own identity + its own relay connection) and the
// in-shell embedded version (mount.mjs: reuses the QUniverse shell's
// ALREADY-connected `qu`, no second identity/connection bootstrap) share,
// so a fix or a new panel only has to be written once. `root` is whichever
// DOM subtree already contains this exact markup (index.html's static
// HTML for the standalone page, or mount.mjs's freshly-injected equivalent
// for the embedded version) — `root.querySelector('#...')` finds every
// element the same way either way, so this function itself has no opinion
// on where its markup came from.
//
// `qu` must already have createNetworkPlugin()/createSpacesPlugin()
// installed AND (for any write here to actually reach the relay, not just
// its own local store) an active connection — see createSpacesPlugin()'s
// own reasoning below for why the plugin specifically matters. Whether
// that's a fresh bootstrap or an already-running shell session is entirely
// the CALLER's decision; this function only ever wires UI to an
// already-ready `qu`.

import { PLATFORM_MODULES } from '../../server/platform-registry.mjs'; // labels only (id -> label) — the actual enabled state always comes live from /relay/info, never from this static list
import { getTheme, setTheme } from '../../src/ui/theme.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Wires every panel in `root` to `qu` (already connected) and `info`
 * (`/relay/info`, already fetched by the caller — see mount.mjs/app.mjs).
 * Returns nothing — this is a one-time wiring pass, not a live component;
 * every reactive bit here is its own re-fetch-after-write confirmation
 * (see togglePlatformModule()'s own doc comment), same as the original
 * standalone-only version this was extracted from. No longer covers
 * per-app enable/disable (moved to services/app-directory/app.mjs) —
 * this stays scoped to genuine relay-wide operations (rate-limit,
 * connection-limit, platform-modules, theme, deployment config).
 */
export async function initAdminPanel(root, qu, info) {
  const $ = (id) => root.querySelector(`#${id}`);
  const myFpEl = $('my-fp');
  const relayFpEl = $('relay-fp');
  const connStatusEl = $('conn-status');
  const statusEl = $('status');
  const rateLimitFormEl = $('rate-limit-form');
  const rateLimitOffEl = $('rate-limit-off');
  const rateLimitMaxEl = $('rate-limit-max');
  const rateLimitWindowEl = $('rate-limit-window');
  const rateLimitSaveBtn = $('rate-limit-save');
  const connectionLimitMaxEl = $('connection-limit-max');
  const connectionLimitFpsEl = $('connection-limit-fps');
  const connectionLimitSaveBtn = $('connection-limit-save');
  const platformModulesListEl = $('platform-modules-list');
  const platformModulesOffEl = $('platform-modules-off');
  const themeAccentEl = $('theme-accent');
  const themeBgEl = $('theme-bg');
  const themeTextEl = $('theme-text');
  const themeSaveBtn = $('theme-save');
  const themeClearBtn = $('theme-clear');
  const deploymentPanelEl = $('deployment-panel');
  const deploymentOffEl = $('deployment-off');
  const deploymentQuniverseEl = $('deployment-quniverse');
  const deploymentDocsEl = $('deployment-docs');
  const deploymentExamplesEl = $('deployment-examples');
  const deploymentStoreEl = $('deployment-store');
  const deploymentPushEl = $('deployment-push');
  const deploymentTurnEl = $('deployment-turn');

  function showStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = `status ${kind}`;
    statusEl.hidden = false;
  }

  /**
   * `deployment` — index.js's own startup-time env-var choices
   * (server/relay-info-routes.mjs's own doc explains why these are
   * read-only: unlike `adminConfig`, there is no `admin/config/*` write
   * path for any of them, and never will be — they gate which code paths
   * were even initialized at process start). `null` for a relay that
   * doesn't pass this option at all (e.g. an older deployment, or one
   * that considers even this much detail too much to expose) — shows the
   * explanatory hint instead of stale/misleading fields.
   */
  function renderDeployment(deployment) {
    if (!deployment) {
      deploymentPanelEl.hidden = true;
      deploymentOffEl.hidden = false;
      return;
    }
    deploymentPanelEl.hidden = false;
    deploymentOffEl.hidden = true;
    deploymentQuniverseEl.textContent = deployment.content?.quniverse ? 'an' : 'aus';
    deploymentDocsEl.textContent = deployment.content?.docs ? 'an' : 'aus';
    deploymentExamplesEl.textContent = deployment.content?.examples ? 'an' : 'aus';
    deploymentStoreEl.textContent = deployment.store === 'persistent' ? 'persistent' : 'flüchtig (QU_STORE=memory)';
    deploymentPushEl.textContent = deployment.push?.enabled ? `an (${deployment.push.subject})` : 'aus (QU_PUSH=0)';
    deploymentTurnEl.textContent = deployment.turnConfigured ? 'konfiguriert' : 'nicht konfiguriert (nur STUN)';
  }

  /**
   * Populates both config-form panels from `/relay/info`'s `adminConfig`
   * (relay/relay.mjs's getAdminConfig(), see server/relay-info-routes.mjs) —
   * called once at startup and again after every save, so the form always
   * shows what the relay ACTUALLY has configured, not just what was last
   * submitted (the same "re-read to confirm" principle togglePlatformModule()
   * below already uses). `rateLimit` is `null` when this
   * relay wasn't given a rateLimiter at all (`QU_RATE_LIMIT=0`) — the
   * panel then shows an explanatory hint instead of inputs with no real
   * values behind them.
   */
  function renderAdminConfig({ rateLimit, connectionLimit }) {
    if (rateLimit) {
      rateLimitFormEl.hidden = false;
      rateLimitOffEl.hidden = true;
      rateLimitMaxEl.value = rateLimit.maxPerWindow;
      rateLimitWindowEl.value = rateLimit.windowMs;
    } else {
      rateLimitFormEl.hidden = true;
      rateLimitOffEl.hidden = false;
    }
    connectionLimitMaxEl.value = connectionLimit?.maxConnections ?? '';
    connectionLimitFpsEl.value = (connectionLimit?.allowedFingerprints ?? []).join(', ');
  }

  async function refreshAdminConfig() {
    const freshInfo = await fetchJSON('/relay/info');
    const adminConfig = freshInfo.adminConfig ?? { rateLimit: null, connectionLimit: null, platformModules: null };
    renderAdminConfig(adminConfig);
    renderPlatformModules(adminConfig.platformModules);
    return adminConfig;
  }

  /**
   * `platformModules`: `{ [id]: boolean }` (server/platform-registry.mjs's
   * getConfig() shape) or `null` if this relay wasn't given a
   * platformRegistry at all. Labels come from the static `PLATFORM_MODULES`
   * import above — only the enabled flag is ever live/server-sourced.
   */
  function renderPlatformModules(platformModules) {
    if (!platformModules) {
      platformModulesListEl.hidden = true;
      platformModulesOffEl.hidden = false;
      return;
    }
    platformModulesListEl.hidden = false;
    platformModulesOffEl.hidden = true;
    platformModulesListEl.textContent = '';
    for (const { id, label } of PLATFORM_MODULES) {
      const enabled = platformModules[id] ?? false;
      const li = document.createElement('li');

      const name = document.createElement('div');
      name.className = 'name';
      const labelEl = document.createElement('div');
      labelEl.textContent = label;
      const idEl = document.createElement('div');
      idEl.className = 'id';
      idEl.textContent = id;
      name.append(labelEl, idEl);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = enabled ? 'enabled' : 'disabled';
      toggleBtn.textContent = enabled ? '● aktiv' : '○ deaktiviert';
      toggleBtn.addEventListener('click', () => togglePlatformModule(id, label, enabled, toggleBtn));

      li.append(name, toggleBtn);
      platformModulesListEl.appendChild(li);
    }
  }

  myFpEl.textContent = qu.fingerprint;
  relayFpEl.textContent = info.fingerprint;
  connStatusEl.textContent = 'verbunden';
  renderDeployment(info.deployment ?? null);
  const initialAdminConfig = info.adminConfig ?? { rateLimit: null, connectionLimit: null, platformModules: null };
  renderAdminConfig(initialAdminConfig);
  renderPlatformModules(initialAdminConfig.platformModules);

  // Learn the relay's ECDH public key directly from `info` instead of
  // syncing `~<relayFp>/epub` over the network first — trustPeer() takes
  // precedence over a synced value anyway (core/session.js's own doc
  // comment), so this just removes an otherwise-needed "wait for the
  // relay's profile to sync before the very first command can be
  // encrypted" step. Cheap/idempotent — safe to call even if the caller's
  // `qu` already trusted this exact relay earlier in its lifetime.
  await qu.session.trustPeer(info.fingerprint, info.epub);

  /**
   * Same fire-and-forget-then-reread confirmation as the rate-limit/
   * connection-limit save handlers below — a single module's flag flips
   * via `{ modules: { [id]: !enabled } }`, leaving every other module's
   * state untouched (server/platform-registry.mjs's configure() only ever
   * patches the ids present in the payload). Per-app enable/disable now
   * lives in services/app-directory/app.mjs instead of here (its own
   * toggleService() uses the identical `admin/service/<id>` protocol) —
   * this panel stays scoped to genuine relay-wide operations.
   */
  async function togglePlatformModule(id, label, enabled, btn) {
    btn.disabled = true;
    try {
      await qu.session.publish('admin/config/platform-modules', { modules: { [id]: !enabled } }, { encryptFor: [info.fingerprint] });
      await wait(200);
      const { platformModules } = await refreshAdminConfig();
      if (platformModules && platformModules[id] === !enabled) {
        showStatus(`"${label}" ${enabled ? 'deaktiviert' : 'aktiviert'}.`, 'ok');
      } else {
        showStatus(`"${label}" unverändert — keine Bestätigung vom Relay erhalten. Ist deine Identität (${qu.fingerprint}) als QU_RELAY_ADMINS-Fingerprint hinterlegt?`, 'err');
      }
    } catch (e) {
      showStatus(`Fehlgeschlagen: ${e.message}`, 'err');
      btn.disabled = false;
    }
  }

  rateLimitSaveBtn.addEventListener('click', async () => {
    rateLimitSaveBtn.disabled = true;
    try {
      const maxPerWindow = Number(rateLimitMaxEl.value);
      const windowMs = Number(rateLimitWindowEl.value);
      await qu.session.publish('admin/config/rate-limit', { maxPerWindow, windowMs }, { encryptFor: [info.fingerprint] });
      await wait(200); // dem Relay Zeit geben, das Kommando zu verarbeiten, bevor der aktuelle Stand neu gelesen wird
      const { rateLimit } = await refreshAdminConfig();
      if (rateLimit && rateLimit.maxPerWindow === maxPerWindow && rateLimit.windowMs === windowMs) {
        showStatus('Rate-Limit gespeichert.', 'ok');
      } else {
        showStatus(`Rate-Limit unverändert — keine Bestätigung vom Relay erhalten. Ist deine Identität (${qu.fingerprint}) als QU_RELAY_ADMINS-Fingerprint hinterlegt?`, 'err');
      }
    } catch (e) {
      showStatus(`Rate-Limit speichern fehlgeschlagen: ${e.message}`, 'err');
    } finally {
      rateLimitSaveBtn.disabled = false;
    }
  });

  /**
   * `relay-config/theme` is ordinary, ACL-gated Space content (relay/
   * relay.mjs's `relay-config/` branch — writers: relayAdmins, readers:
   * '*'), NOT the encrypted `admin/` command channel — a plain
   * `qu.session.publish()`/`setTheme()`, no `encryptFor` needed (see
   * src/ui/theme.js's own file doc). Reading it back afterward to confirm
   * still matters just as much: a rejected write here doesn't throw
   * either (the LOCAL write succeeds unconditionally, same
   * createSpacesPlugin() reasoning as every other write in this file).
   */
  async function refreshThemeForm() {
    const theme = await getTheme(qu);
    themeAccentEl.value = theme?.accent ?? '';
    themeBgEl.value = theme?.bg ?? '';
    themeTextEl.value = theme?.text ?? '';
    return theme;
  }
  await refreshThemeForm();

  themeSaveBtn.addEventListener('click', async () => {
    themeSaveBtn.disabled = true;
    try {
      const theme = {};
      if (themeAccentEl.value.trim()) theme.accent = themeAccentEl.value.trim();
      if (themeBgEl.value.trim()) theme.bg = themeBgEl.value.trim();
      if (themeTextEl.value.trim()) theme.text = themeTextEl.value.trim();
      await setTheme(qu, theme);
      await wait(200);
      const confirmed = await refreshThemeForm();
      if (confirmed && JSON.stringify(confirmed) === JSON.stringify(theme)) {
        showStatus('Theme gespeichert.', 'ok');
      } else {
        showStatus(`Theme unverändert — keine Bestätigung vom Relay erhalten. Ist deine Identität (${qu.fingerprint}) als QU_RELAY_ADMINS-Fingerprint hinterlegt?`, 'err');
      }
    } catch (e) {
      showStatus(`Theme speichern fehlgeschlagen: ${e.message}`, 'err');
    } finally {
      themeSaveBtn.disabled = false;
    }
  });

  themeClearBtn.addEventListener('click', async () => {
    themeClearBtn.disabled = true;
    try {
      await setTheme(qu, null);
      await wait(200);
      const confirmed = await refreshThemeForm();
      showStatus(confirmed === null ? 'Theme zurückgesetzt.' : 'Theme unverändert — keine Bestätigung vom Relay erhalten.', confirmed === null ? 'ok' : 'err');
    } catch (e) {
      showStatus(`Theme zurücksetzen fehlgeschlagen: ${e.message}`, 'err');
    } finally {
      themeClearBtn.disabled = false;
    }
  });

  connectionLimitSaveBtn.addEventListener('click', async () => {
    connectionLimitSaveBtn.disabled = true;
    try {
      const maxConnections = connectionLimitMaxEl.value === '' ? null : Number(connectionLimitMaxEl.value);
      const allowedFingerprints = connectionLimitFpsEl.value.trim()
        ? connectionLimitFpsEl.value.split(',').map((s) => s.trim()).filter(Boolean)
        : null;
      await qu.session.publish('admin/config/connection-limit', { maxConnections, allowedFingerprints }, { encryptFor: [info.fingerprint] });
      await wait(200);
      const { connectionLimit } = await refreshAdminConfig();
      const fpsMatch = JSON.stringify(connectionLimit?.allowedFingerprints ?? null) === JSON.stringify(allowedFingerprints);
      if (connectionLimit && connectionLimit.maxConnections === maxConnections && fpsMatch) {
        showStatus('Verbindungslimit gespeichert.', 'ok');
      } else {
        showStatus(`Verbindungslimit unverändert — keine Bestätigung vom Relay erhalten. Ist deine Identität (${qu.fingerprint}) als QU_RELAY_ADMINS-Fingerprint hinterlegt?`, 'err');
      }
    } catch (e) {
      showStatus(`Verbindungslimit speichern fehlgeschlagen: ${e.message}`, 'err');
    } finally {
      connectionLimitSaveBtn.disabled = false;
    }
  });
}
