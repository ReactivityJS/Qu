// Relay-Admin — Services eines Relays ein-/ausschalten über signierte,
// verschlüsselte Admin-Kommandos (relay/relay.mjs's `admin/**`-Listener,
// server/service-registry.mjs). Bewusst KEIN eigener Login/Auth-Mechanismus:
// dieselbe lokal persistierte Identität wie jede andere Qu-App
// (space-app-browser.js's loadOrCreateIdentity()) — ob sie tatsächlich
// administrieren darf, entscheidet ausschließlich das Relay (QU_RELAY_ADMINS,
// ACL-geprüft bei jedem Schreibversuch), nicht diese Seite. Eine Person
// ohne Admin-Rechte kann diese Seite öffnen und sieht den Katalog, aber
// jeder Toggle-Versuch scheitert sichtbar an der Relay-ACL — Verstecken
// der Seite selbst wäre keine echte Sicherheitsgrenze (siehe index.js's
// Kommentar zur 'admin'-Kategorie).

import { createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { PLATFORM_MODULES } from '../../server/platform-registry.mjs'; // labels only (id -> label) — the actual enabled state always comes live from /relay/info, never from this static list
import { getTheme, setTheme } from '../../src/ui/theme.js';

const IDENTITY_KEY = 'qu-identity'; // siehe examples/chat/app.mjs's IDENTITY_KEY-Doku — bewusst DERSELBE Wert wie chat/people: EIN Fingerprint fürs gesamte Ökosystem, kein pro-App-Konto. Ein früherer eigener Key hier ('qu-relay-admin-identity') war ein Fehler — QU_RELAY_ADMINS wird typischerweise mit dem Fingerprint gepinnt, den man schon aus Chat/People kennt; ein zweiter, abweichender Key hätte hier still eine ANDERE Identität angelegt, die nie zu QU_RELAY_ADMINS passt, egal was dort eingetragen ist.

function $(id) { return document.getElementById(id); }
const myFpEl = $('my-fp');
const relayFpEl = $('relay-fp');
const connStatusEl = $('conn-status');
const statusEl = $('status');
const listEl = $('service-list');
const refreshBtn = $('refresh-btn');
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

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

function renderServices(services) {
  listEl.textContent = '';
  for (const svc of services) {
    const li = document.createElement('li');

    const name = document.createElement('div');
    name.className = 'name';
    const label = document.createElement('div');
    label.textContent = svc.label;
    const id = document.createElement('div');
    id.className = 'id';
    id.textContent = svc.id;
    name.append(label, id);

    const badge = document.createElement('span');
    badge.className = 'category-badge';
    badge.textContent = svc.category;

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = svc.enabled ? 'enabled' : 'disabled';
    toggleBtn.textContent = svc.enabled ? '● aktiv' : '○ deaktiviert';
    toggleBtn.addEventListener('click', () => toggleService(svc, toggleBtn));

    li.append(name, badge, toggleBtn);
    listEl.appendChild(li);
  }
}

/**
 * `deployment` — index.js's own startup-time env-var choices
 * (server/relay-info-routes.mjs's own doc explains why these are
 * read-only: unlike `adminConfig`, there is no `admin/config/*` write
 * path for any of them, and never will be — they gate which code paths
 * were even initialized at process start). `null` for a relay that
 * doesn't pass this option at all (e.g. an older deployment, or one that
 * considers even this much detail too much to expose) — shows the
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

let toggleService; // assigned in main() once `qu`/relay info are known — see below

async function refreshCatalog() {
  const services = await fetchJSON('/relay/services');
  renderServices(services);
  return services;
}

/**
 * Populates both config-form panels from `/relay/info`'s `adminConfig`
 * (relay/relay.mjs's getAdminConfig(), see server/relay-info-routes.mjs) —
 * called once at startup and again after every save, so the form always
 * shows what the relay ACTUALLY has configured, not just what was last
 * submitted (the same "re-read to confirm" principle toggleService() below
 * already uses for services). `rateLimit` is `null` when this relay wasn't
 * given a rateLimiter at all (`QU_RATE_LIMIT=0`) — the panel then shows an
 * explanatory hint instead of inputs with no real values behind them.
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
  const info = await fetchJSON('/relay/info');
  const adminConfig = info.adminConfig ?? { rateLimit: null, connectionLimit: null, platformModules: null };
  renderAdminConfig(adminConfig);
  renderPlatformModules(adminConfig.platformModules);
  return adminConfig;
}

let togglePlatformModule; // assigned in main() once `qu`/relay info are known — same deferred-assignment shape as toggleService() above

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

async function main() {
  const qu = await loadOrCreateIdentity(IDENTITY_KEY);
  myFpEl.textContent = qu.fingerprint;

  const info = await fetchJSON('/relay/info');
  relayFpEl.textContent = info.fingerprint;
  renderDeployment(info.deployment ?? null);
  const initialAdminConfig = info.adminConfig ?? { rateLimit: null, connectionLimit: null, platformModules: null };
  renderAdminConfig(initialAdminConfig);
  renderPlatformModules(initialAdminConfig.platformModules);

  // createSpacesPlugin() is needed here for a subtle reason unrelated to
  // Spaces themselves: WITHOUT it, this Qu instance's LOCAL ingest() still
  // enforces the Core default ACL (core/identity-acl.js — "only writers
  // may write under their own ~<fingerprint>"), which would reject
  // `admin/service/<id>` before the write ever reaches the network at
  // all. With the Spaces plugin installed, `admin/service/<id>`'s Space
  // id is `admin` (core/space.js's spaceIdOf(), the first path segment) —
  // a plain generic Space this app never creates a manifest for, so the
  // Spaces bootstrap rule ("no manifest yet = anyone may write") lets the
  // LOCAL write through unconditionally. The relay's OWN, separate ACL
  // check (relay/relay.mjs's `admin/` branch, restricted to
  // QU_RELAY_ADMINS) is what actually enforces authorization — this local
  // check only ever needed to get out of its own way.
  qu.use(createNetworkPlugin()).use(createSpacesPlugin());
  // Learn the relay's ECDH public key directly from /relay/info instead of
  // syncing `~<relayFp>/epub` over the network first — trustPeer() takes
  // precedence over a synced value anyway (core/session.js's own doc
  // comment), so this just removes an otherwise-needed "wait for the
  // relay's profile to sync before the very first command can be
  // encrypted" step.
  await qu.session.trustPeer(info.fingerprint, info.epub);

  /**
   * Builds+signs+encrypts an `admin/service/<id>` command and publishes it
   * — `session.publish(id, value, { encryptFor })` (core/session.js) is
   * the entire mechanism; no bespoke crypto code needed here (see
   * README's "Admin-Kommandos" section for the full protocol).
   *
   * A REJECTED command (e.g. this identity isn't actually a
   * QU_RELAY_ADMINS fingerprint) does NOT throw here — `publish()` only
   * awaits the LOCAL write (this Qu instance's own store accepts it
   * unconditionally, see the createSpacesPlugin() comment above), the
   * relay's rejection happens asynchronously, server-side, with no
   * ack/nack routed back to the sender (network/replication/default.js's
   * push path is fire-and-forget by design). So success is verified by
   * RE-READING the catalog afterwards and checking it actually changed as
   * expected — the absence of a thrown error is not, on its own, proof of
   * anything.
   */
  toggleService = async (svc, btn) => {
    btn.disabled = true;
    try {
      await qu.session.publish(`admin/service/${svc.id}`, { enabled: !svc.enabled }, { encryptFor: [info.fingerprint] });
      await wait(200); // dem Relay Zeit geben, das Kommando zu verarbeiten, bevor der Katalog neu gelesen wird
      const services = await refreshCatalog();
      const updated = services.find((s) => s.id === svc.id);
      if (updated && updated.enabled === !svc.enabled) {
        showStatus(`"${svc.label}" ${svc.enabled ? 'deaktiviert' : 'aktiviert'}.`, 'ok');
      } else {
        showStatus(`"${svc.label}" unverändert — keine Bestätigung vom Relay erhalten. Ist deine Identität (${qu.fingerprint}) als QU_RELAY_ADMINS-Fingerprint hinterlegt?`, 'err');
      }
    } catch (e) {
      showStatus(`Fehlgeschlagen: ${e.message}`, 'err');
      btn.disabled = false;
    }
  };

  /**
   * Same fire-and-forget-then-reread confirmation as toggleService() above
   * — `admin/config/*` commands never ack, so success is only ever proven
   * by re-fetching `/relay/info` afterward and checking it reflects the
   * new values, not by the absence of a thrown error.
   */
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
   * Same fire-and-forget-then-reread confirmation as toggleService()/the
   * rate-limit/connection-limit save handlers above — a single module's
   * flag flips via `{ modules: { [id]: !enabled } }`, leaving every other
   * module's state untouched (server/platform-registry.mjs's configure()
   * only ever patches the ids present in the payload).
   */
  togglePlatformModule = async (id, label, enabled, btn) => {
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
  };

  /**
   * `relay-config/theme` is ordinary, ACL-gated Space content (relay/
   * relay.mjs's `relay-config/` branch — writers: relayAdmins, readers:
   * '*'), NOT the encrypted `admin/` command channel — a plain
   * `qu.session.publish()`/`setTheme()`, no `encryptFor` needed (see
   * src/ui/theme.js's own file doc). Reading it back afterward to confirm
   * still matters just as much: a rejected write here doesn't throw either
   * (the LOCAL write succeeds unconditionally, same createSpacesPlugin()
   * reasoning as every other write in this file).
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

  async function connectToRelay() {
    const channel = createWebSocketChannel(relayUrl());
    await Promise.race([
      channel.connect(),
      wait(10000).then(() => { throw new Error('Zeitüberschreitung beim Verbindungsaufbau'); }),
    ]);
    await qu.connect(channel, { pushTopics: [''] });
    connStatusEl.textContent = 'verbunden';
  }
  async function connectWithRetry() {
    for (let attempt = 0; ; attempt++) {
      try { await connectToRelay(); return; } catch (e) {
        connStatusEl.textContent = 'Verbindung fehlgeschlagen, erneuter Versuch …';
        console.error('[relay-admin] connect failed:', e);
        await wait(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
  }
  window.addEventListener('online', () => { connectToRelay().catch((e) => console.error('[relay-admin] reconnect failed:', e)); });

  await connectWithRetry();
  await refreshCatalog();
}

refreshBtn.addEventListener('click', () => { refreshCatalog().catch((e) => showStatus(`Aktualisieren fehlgeschlagen: ${e.message}`, 'err')); });

main().catch((e) => {
  console.error('[relay-admin] startup failed:', e);
  showStatus(`Start fehlgeschlagen: ${e.message}`, 'err');
});
