// Beispiel (Oberfläche): siehe ../hunt-lib.mjs für die eigentliche Logik
// (Spiel/Ping/Radius-Vorhersage) — diese Datei ist nur die dünne UI-Schicht
// darüber (Leaflet-Karte, Geolocation), im selben Stil wie examples/forum/app.mjs.

import { createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../../src/index.js';
import {
  createGame, getConfig, getStatus, onStatusChange, isHunted, isHunter,
  pingLocation, listPings, onPing, declareCaught, predictNextRadius,
} from '../hunt-lib.mjs';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { parseHashRoute, buildHashRoute } from '../space-app-lib.mjs';

const IDENTITY_KEY = 'qu-hunt-identity-keys'; // eigener Key, unabhängig von anderen Beispielen

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const setupBox = el('setup-box');
const hunterFpsInput = el('hunter-fps');
const pingIntervalInput = el('ping-interval');
const assumedSpeedInput = el('assumed-speed');
const createGameBtn = el('create-game-btn');
const shareBox = el('share-box');
const shareLinkEl = el('share-link');
const gameBox = el('game-box');
const gameStatusEl = el('game-status');
const huntedControls = el('hunted-controls');
const intervalLabelEl = el('interval-label');
const trackBtn = el('track-btn');
const lastPingInfoEl = el('last-ping-info');
const hunterControls = el('hunter-controls');
const radiusInfoEl = el('radius-info');
const caughtBtn = el('caught-btn');
const mapEl = el('map');

function setStatusBadge(state) {
  gameStatusEl.textContent = { active: 'aktiv', caught: 'gefangen', ended: 'beendet' }[state] ?? state;
  gameStatusEl.className = `badge ${state}`;
}

function parseFingerprintList(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main() {
  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  const { spaceId: gameId } = parseHashRoute(location.hash);

  // Ein neues Spiel bekommt seine Id erst zur Laufzeit (`qu.createSpace()`,
  // siehe README Abschnitt 3/APP-GUIDE Schritt 3) — deshalb hier
  // `pushTopics: ['']` ("push alles, was ich selbst schreibe") statt eines
  // festen Präfixes, das die Id vorher kennen müsste. Verbinden MUSS bereits
  // vor createGame() passieren, sonst landet das Manifest nie beim Relay
  // und ein zweites Gerät (oder dieselbe Seite nach einem Reload) sieht nie
  // mehr als eine leere, lokale Kopie.
  const repl = await qu.connect(channel, { pushTopics: [''] });

  if (!gameId) {
    statusEl.textContent = 'Verbunden — bereit, ein neues Spiel zu erstellen';
    setupBox.classList.remove('hidden');
    createGameBtn.addEventListener('click', async () => {
      createGameBtn.disabled = true;
      const hunterTeam = parseFingerprintList(hunterFpsInput.value);
      const pingIntervalMs = Math.max(1, Number(pingIntervalInput.value) || 5) * 60_000;
      const assumedSpeedMps = Math.max(0, Number(assumedSpeedInput.value) || 1.4);
      const newGameId = await createGame(qu, { huntedTeam: [qu.fingerprint], hunterTeam, pingIntervalMs, assumedSpeedMps });
      location.hash = buildHashRoute(newGameId);
      location.reload(); // einfachste Variante, um mit dem "gameId vorhanden"-Zweig unten neu zu starten
    });
    return;
  }

  setupBox.classList.add('hidden');
  statusEl.textContent = 'Synchronisiere …';
  await repl.sync({ topic: gameId, since: 0 });
  statusEl.textContent = 'Verbunden';

  shareLinkEl.value = `${location.origin}${location.pathname}${buildHashRoute(gameId)}`;
  shareBox.classList.remove('hidden');
  gameBox.classList.remove('hidden');

  const config = await getConfig(qu, gameId);
  if (!config) {
    statusEl.textContent = 'Fehler: Spiel nicht gefunden (falscher Link oder noch nicht synchronisiert)';
    return;
  }

  intervalLabelEl.textContent = String(Math.round(config.pingIntervalMs / 60_000));

  const status = await getStatus(qu, gameId);
  if (status) setStatusBadge(status.state);
  onStatusChange(qu, gameId, (q) => setStatusBadge(q.value.state));

  const hunted = await isHunted(qu, gameId);
  const hunter = await isHunter(qu, gameId);

  if (hunted) {
    huntedControls.classList.remove('hidden');
    setupHuntedControls();
  }
  if (hunter || !hunted) {
    // Fänger-Team ODER ein reiner Beobachter (Link ohne eigene Team-Rolle) —
    // beide bekommen dieselbe Karten-Ansicht; nur der "Team gefunden"-Button
    // bleibt unten auf echte Fänger beschränkt.
    hunterControls.classList.remove('hidden');
    caughtBtn.classList.toggle('hidden', !hunter);
    if (hunter) caughtBtn.addEventListener('click', () => declareCaught(qu, gameId));
    await setupMap(qu, gameId, config);
  }

  // --- Gejagtes Team: Geolocation + periodisches Pingen ---
  function setupHuntedControls() {
    let watchId = null;
    let intervalId = null;
    let currentPosition = null;
    let tracking = false;

    async function sendPing() {
      if (!currentPosition) return;
      const { latitude: lat, longitude: lon, accuracy, speed } = currentPosition.coords;
      await pingLocation(qu, gameId, { lat, lon, accuracy, speedMps: speed ?? null });
      lastPingInfoEl.textContent = `Zuletzt gemeldet: ${new Date().toLocaleTimeString()} (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
    }

    trackBtn.addEventListener('click', () => {
      if (tracking) {
        navigator.geolocation.clearWatch(watchId);
        clearInterval(intervalId);
        tracking = false;
        trackBtn.textContent = 'Tracking starten';
        return;
      }
      let firstFix = true;
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          currentPosition = pos;
          // Der erste tatsächliche GPS-Fix löst sofort einen Ping aus
          // (nicht schon der Klick selbst — zu diesem Zeitpunkt liegt noch
          // gar keine Position vor), danach übernimmt allein das Intervall.
          if (firstFix) { firstFix = false; sendPing().catch((e) => { lastPingInfoEl.textContent = `Fehler: ${e.message}`; }); }
        },
        (err) => { lastPingInfoEl.textContent = `Geolocation-Fehler: ${err.message}`; },
        { enableHighAccuracy: true },
      );
      intervalId = setInterval(() => { sendPing().catch((e) => { lastPingInfoEl.textContent = `Fehler: ${e.message}`; }); }, config.pingIntervalMs);
      tracking = true;
      trackBtn.textContent = 'Tracking stoppen';
    });
  }
}

// --- Fänger-Team/Beobachter: Karte mit Weg + vorausberechnetem Radius ---
async function setupMap(qu, gameId, config) {
  const map = L.map(mapEl).setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap-Mitwirkende',
    maxZoom: 19,
  }).addTo(map);

  const path = L.polyline([], { color: '#7dd3fc' }).addTo(map);
  const markers = L.layerGroup().addTo(map);
  const radiusCircle = L.circle([0, 0], { radius: 0, color: '#f87171', fillOpacity: 0.08, dashArray: '6 6' }).addTo(map);

  let pings = await listPings(qu, gameId);
  let hasFitted = false;

  function render() {
    path.setLatLngs(pings.map((q) => [q.value.lat, q.value.lon]));
    markers.clearLayers();
    pings.forEach((q, i) => {
      const isLast = i === pings.length - 1;
      L.circleMarker([q.value.lat, q.value.lon], {
        radius: isLast ? 8 : 5,
        color: isLast ? '#4ade80' : '#7dd3fc',
        fillOpacity: 0.9,
      })
        .bindPopup(`${new Date(q.ts).toLocaleTimeString()}`)
        .addTo(markers);
    });
    if (pings.length && !hasFitted) {
      map.fitBounds(path.getBounds(), { maxZoom: 16, padding: [30, 30] });
      hasFitted = true;
    }
    updateRadius();
  }

  function updateRadius() {
    const prediction = predictNextRadius(pings, config, Date.now());
    if (!prediction) {
      radiusInfoEl.textContent = 'Noch kein Standort gemeldet.';
      radiusCircle.setRadius(0);
      return;
    }
    radiusCircle.setLatLng([prediction.center.lat, prediction.center.lon]);
    radiusCircle.setRadius(prediction.radiusMeters);
    radiusInfoEl.textContent = `Geschätzter Radius: ${Math.round(prediction.radiusMeters)} m `
      + `(angenommenes Tempo ${prediction.speedMps.toFixed(2)} m/s, `
      + `${Math.round(prediction.elapsedS)}s seit letztem Ping)`;
  }

  render();
  setInterval(updateRadius, 1000); // Radius wächst live weiter, auch ohne neuen Ping

  onPing(qu, gameId, async () => {
    pings = await listPings(qu, gameId);
    render();
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  console.error(e);
});
