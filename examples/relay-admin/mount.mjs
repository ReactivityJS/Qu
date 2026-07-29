// In-shell embedded Relay-Admin — the mount-contract counterpart to
// app.mjs's standalone page (services/README.md's App-Manifest doc): same
// markup shape (same ids, so panel.mjs's `root.querySelector('#...')`
// lookups work unmodified), same panel.mjs wiring, but reuses the
// QUniverse shell's ALREADY-connected `qu` instead of a second identity
// bootstrap + a second WebSocket connection to the same relay. Styling
// comes from shell/style.css's `.qu-relay-admin-embed`-scoped rules
// (adapted from ./style.css, which this mount never loads) rather than a
// second stylesheet, so nothing here can leak/override styles for any
// other mounted app or screen.

import { initAdminPanel } from './panel.mjs';

const MARKUP = `
  <h2>🛠️ Relay-Admin</h2>
  <p class="hint">
    Services dieses Relays ein-/ausschalten. Jede Änderung ist ein signiertes,
    NUR für diesen Relay verschlüsseltes Kommando — wirkt nur, wenn deine
    Identität als <code>QU_RELAY_ADMINS</code>-Fingerprint beim Relay
    hinterlegt ist. Diese Seite selbst prüft das nicht (kann sie nicht — sie
    zeigt einfach, was das Relay bei Ablehnung meldet).
  </p>

  <section id="identity-panel" class="panel">
    <div><span class="label">Deine Identität</span> <code id="my-fp">…</code></div>
    <div><span class="label">Relay</span> <code id="relay-fp">…</code></div>
    <div><span class="label">Verbindung</span> <span id="conn-status">verbindet …</span></div>
  </section>

  <section id="status" class="status" hidden></section>

  <section class="panel">
    <h2>Server-Konfiguration</h2>
    <p class="hint">Startup-Umgebungsvariablen dieses Prozesses (siehe README) — rein lesend: diese Werte
      entscheiden, welche Code-Pfade beim Start überhaupt initialisiert wurden (z. B. ob ein persistenter
      Store geöffnet wurde), und lassen sich deshalb NICHT über ein Admin-Kommando ändern, anders als die
      Panels unten — nur ein Neustart mit anderen Umgebungsvariablen ändert sie.</p>
    <div id="deployment-panel">
      <div><span class="label">QUniverse-Shell ("/")</span> <span id="deployment-quniverse">…</span></div>
      <div><span class="label">Dokumentation</span> <span id="deployment-docs">…</span></div>
      <div><span class="label">Lern-Demos (examples/)</span> <span id="deployment-examples">…</span></div>
      <div><span class="label">Store</span> <span id="deployment-store">…</span></div>
      <div><span class="label">Web Push</span> <span id="deployment-push">…</span></div>
      <div><span class="label">TURN (WebRTC)</span> <span id="deployment-turn">…</span></div>
    </div>
    <p id="deployment-off" class="hint" hidden>Dieses Relay liefert keine Deployment-Konfiguration (kein <code>deployment</code>-Feld in <code>/relay/info</code>).</p>
  </section>

  <section class="panel">
    <div class="panel-head">
      <h2>Services</h2>
      <button id="refresh-btn" type="button">↻ Aktualisieren</button>
    </div>
    <ul id="service-list" class="service-list"></ul>
  </section>

  <section class="panel">
    <h2>Rate-Limit</h2>
    <p class="hint">Schreibvorgänge pro Fingerprint, innerhalb eines Zeitfensters. Ohne konfiguriertes Rate-Limit
      (<code>QU_RATE_LIMIT=0</code>) zeigt dieses Panel keine Werte an.</p>
    <div id="rate-limit-form" class="config-form" hidden>
      <label>Max. Schreibvorgänge <input id="rate-limit-max" type="number" min="1" /></label>
      <label>Zeitfenster (ms) <input id="rate-limit-window" type="number" min="1" /></label>
      <button id="rate-limit-save" type="button">Speichern</button>
    </div>
    <p id="rate-limit-off" class="hint" hidden>Kein Rate-Limit auf diesem Relay konfiguriert.</p>
  </section>

  <section class="panel">
    <h2>Verbindungslimit</h2>
    <p class="hint">Maximale Anzahl gleichzeitig verbundener Fingerprints, optional zusätzlich auf eine feste
      Fingerprint-Liste beschränkt. Leeres Limit-Feld = kein Limit; leere Liste = keine Einschränkung.</p>
    <div id="connection-limit-form" class="config-form">
      <label>Max. Verbindungen <input id="connection-limit-max" type="number" min="0" placeholder="unbegrenzt" /></label>
      <label>Erlaubte Fingerprints (kommagetrennt, leer = alle)
        <textarea id="connection-limit-fps" rows="2" placeholder="fp1, fp2, …"></textarea>
      </label>
      <button id="connection-limit-save" type="button">Speichern</button>
    </div>
  </section>

  <section class="panel">
    <h2>Plattform-Module</h2>
    <p class="hint">Optionale QUniverse-Shell-Features (Kontaktliste, CMS-Startseite, Benachrichtigungen,
      Verzeichnis, Incognito-Identitäten) — getrennt von den Services oben: diese schalten keine eigene
      App an/aus, sondern welche Bausteine eine Ökosystem-Shell überhaupt installiert/rendert. Ein Relay
      ohne Plattform-Registry (<code>platformRegistry</code> nicht übergeben) zeigt hier keine Module an.</p>
    <ul id="platform-modules-list" class="service-list"></ul>
    <p id="platform-modules-off" class="hint" hidden>Keine Plattform-Registry auf diesem Relay konfiguriert.</p>
  </section>

  <section class="panel">
    <h2>Theme</h2>
    <p class="hint">Deployment-weites Farbschema (CSS Custom Properties), das jede App/jeder Service auf diesem
      Relay lesen kann. Öffentlich lesbar, nur von einem Admin änderbar — ein plain signierter Write auf
      <code>relay-config/theme</code>, kein verschlüsseltes Admin-Kommando (Farbwerte sind nicht geheim).</p>
    <div id="theme-form" class="config-form">
      <label>Akzentfarbe <input id="theme-accent" type="text" placeholder="#3a6df0" /></label>
      <label>Hintergrund <input id="theme-bg" type="text" placeholder="#0d0f14" /></label>
      <label>Textfarbe <input id="theme-text" type="text" placeholder="#e8e8ec" /></label>
      <button id="theme-save" type="button">Speichern</button>
      <button id="theme-clear" type="button">Zurücksetzen</button>
    </div>
  </section>
`;

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function mount(container, { qu }) {
  container.className = 'qu-relay-admin-embed';
  container.innerHTML = MARKUP;

  try {
    const info = await fetchJSON('/relay/info');
    await initAdminPanel(container, qu, info);
  } catch (e) {
    console.error('[relay-admin mount] startup failed:', e);
    const statusEl = container.querySelector('#status');
    statusEl.textContent = `Start fehlgeschlagen: ${e.message}`;
    statusEl.className = 'status err';
    statusEl.hidden = false;
  }
  // Nothing to clean up on navigating away — panel.mjs's writes are all
  // fire-and-forget-then-reread (see its own doc), no live subscription
  // this needs to unsubscribe, same "nothing to clean up" case
  // services/directory/app.mjs's own mount() doc already documents.
}
