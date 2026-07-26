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

const IDENTITY_KEY = 'qu-relay-admin-identity'; // eigener Key — bewusst NICHT dieselbe Identität wie examples/chat/people (ein Relay-Admin ist keine "normale" App-Identität)

function $(id) { return document.getElementById(id); }
const myFpEl = $('my-fp');
const relayFpEl = $('relay-fp');
const connStatusEl = $('conn-status');
const statusEl = $('status');
const listEl = $('service-list');
const refreshBtn = $('refresh-btn');

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

let toggleService; // assigned in main() once `qu`/relay info are known — see below

async function refreshCatalog() {
  const services = await fetchJSON('/relay/services');
  renderServices(services);
  return services;
}

async function main() {
  const qu = await loadOrCreateIdentity(IDENTITY_KEY);
  myFpEl.textContent = qu.fingerprint;

  const info = await fetchJSON('/relay/info');
  relayFpEl.textContent = info.fingerprint;

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
