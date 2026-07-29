// Relay-Admin (standalone page) — Services eines Relays ein-/ausschalten
// über signierte, verschlüsselte Admin-Kommandos (relay/relay.mjs's
// `admin/**`-Listener, server/service-registry.mjs). Bewusst KEIN eigener
// Login/Auth-Mechanismus: dieselbe lokal persistierte Identität wie jede
// andere Qu-App (space-app-browser.js's loadOrCreateIdentity()) — ob sie
// tatsächlich administrieren darf, entscheidet ausschließlich das Relay
// (QU_RELAY_ADMINS, ACL-geprüft bei jedem Schreibversuch), nicht diese
// Seite. Eine Person ohne Admin-Rechte kann diese Seite öffnen und sieht
// den Katalog, aber jeder Toggle-Versuch scheitert sichtbar an der
// Relay-ACL — Verstecken der Seite selbst wäre keine echte
// Sicherheitsgrenze (siehe index.js's Kommentar zur 'admin'-Kategorie).
//
// This file only ever does its OWN identity bootstrap + relay connection
// (a real second WebSocket connection, separate from any QUniverse shell
// tab that might also be open) — the actual panel wiring (services,
// rate-limit, connection-limit, platform-modules, theme, deployment) lives
// in panel.mjs, shared verbatim with mount.mjs's in-shell embedded version
// (shell/qu-app-shell.mjs mounts that one instead, reusing the shell's
// ALREADY-connected `qu` — no second bootstrap there). This file stays the
// bookmarkable, works-without-the-shell fallback entry point.

import { createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from '../../src/index.js';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { initAdminPanel } from './panel.mjs';

const IDENTITY_KEY = 'qu-identity'; // siehe examples/chat/app.mjs's IDENTITY_KEY-Doku — bewusst DERSELBE Wert wie chat/people: EIN Fingerprint fürs gesamte Ökosystem, kein pro-App-Konto. Ein früherer eigener Key hier ('qu-relay-admin-identity') war ein Fehler — QU_RELAY_ADMINS wird typischerweise mit dem Fingerprint gepinnt, den man schon aus Chat/People kennt; ein zweiter, abweichender Key hätte hier still eine ANDERE Identität angelegt, die nie zu QU_RELAY_ADMINS passt, egal was dort eingetragen ist.

function $(id) { return document.getElementById(id); }
const connStatusEl = $('conn-status');

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const qu = await loadOrCreateIdentity(IDENTITY_KEY);

  const info = await fetchJSON('/relay/info');

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

  await initAdminPanel(document, qu, info);
}

main().catch((e) => {
  console.error('[relay-admin] startup failed:', e);
  const statusEl = $('status');
  statusEl.textContent = `Start fehlgeschlagen: ${e.message}`;
  statusEl.className = 'status err';
  statusEl.hidden = false;
});
