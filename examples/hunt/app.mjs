// Beispiel (Oberfläche): siehe ../hunt-lib.mjs für die eigentliche Logik
// (Spiel/Ping/Radius-Vorhersage, gebaut auf viewKey()/viewObject()) — diese
// Datei ist nur die dünne UI-Schicht darüber (Leaflet-Karte, Geolocation,
// PWA-Installierbarkeit, Web Share), im selben Stil wie examples/forum/app.mjs.
//
// Reaktiv im Qu-Sinne heißt hier: KEIN Codepfad liest einmal und abonniert
// dann separat noch einmal (das exakte Muster, das viewKey()/viewObject()
// existieren, um zu vermeiden — siehe docs/lab/labs/
// 05-references-practice.mjs) — Status kommt über watchStatus(), Pings über
// watchPings(), beide liefern bereits Vorhandenes UND künftige Änderungen
// über EINE Subscription. Und kein `location.reload()` als Ersatz für
// "jetzt mit einer neuen Id weitermachen" — ein frisch erstelltes Spiel
// geht direkt in openGame() über, ohne die Seite neu zu laden.
//
// Mobil-Fokus: sobald ein Spiel offen ist, füllt die Karte den gesamten
// verfügbaren Bildschirm (siehe index.html's `body.in-game`), Screen Wake
// Lock hält das Display an (kein Antippen nötig, um "am Leben" zu bleiben),
// und ein paar glanceable Live-Werte (Radius, Alter des letzten Pings,
// eigene Distanz) sollen die Seite auch ohne Interaktion spannend halten.
// Installierbar (manifest.webmanifest + sw.js) und teilbar (Web Share
// Target für eingehende Links, Web Share API für ausgehende) — siehe
// die jeweiligen Abschnitte unten.
//
// Wichtige Grenze, die diese Datei NICHT löst (kein Web-API dafür
// existiert): echtes Tracking bei gesperrtem Display oder im Hintergrund.
// Wake Lock hält nur den Bildschirm an, solange der Tab selbst sichtbar
// ist — Browser (insbesondere mobile) drosseln/pausieren Timer und
// Geolocation zuverlässig, sobald die Seite in den Hintergrund wechselt
// oder das Display sperrt. Das gejagte Team muss die Seite also aktiv im
// Vordergrund halten (siehe #screen-hint in index.html).

import { createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../../src/index.js';
import {
  createGame, getConfig, watchStatus, isHunted, isHunter,
  pingLocation, watchPings, declareCaught, predictNextRadius, haversineMeters,
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
const shareBtn = el('share-btn');
const shareBtnInGame = el('share-btn-ingame');
const installBtn = el('install-btn');
const gameBox = el('game-box');
const gameStatusEl = el('game-status');
const huntedControls = el('hunted-controls');
const intervalLabelEl = el('interval-label');
const trackBtn = el('track-btn');
const lastPingInfoEl = el('last-ping-info');
const nextPingInfoEl = el('next-ping-info');
const hunterControls = el('hunter-controls');
const radiusValueEl = el('radius-value');
const ageValueEl = el('age-value');
const proximityTileEl = el('proximity-tile');
const proximityValueEl = el('proximity-value');
const caughtBtn = el('caught-btn');
const mapEl = el('map');
const wakeLockToggle = el('wakelock-toggle');

function setStatusBadge(state) {
  gameStatusEl.textContent = { active: 'aktiv', caught: 'gefangen', ended: 'beendet' }[state] ?? state;
  gameStatusEl.className = `badge ${state}`;
}

function parseFingerprintList(text) {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

function fmtDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function fmtDistance(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${Math.round(meters)} m`;
}

/**
 * Hält den Bildschirm an, solange die Seite sichtbar ist (Screen Wake
 * Lock API) — der Sperrbildschirm selbst bleibt dadurch aus, was auf
 * vielen Geräten der einzig verlässliche Weg ist, Geolocation/Timer am
 * Laufen zu halten (siehe Moduldoku oben). Das Lock wird vom Browser
 * automatisch freigegeben, sobald der Tab in den Hintergrund wechselt —
 * `visibilitychange` fordert es beim Zurückkehren einfach erneut an.
 * Fehlt die API (älterer Browser), bleibt der Toggle wirkungslos, aber
 * ungefährlich (try/catch schluckt das leise).
 */
function setupWakeLock(toggle) {
  let sentinel = null;

  async function acquire() {
    if (!toggle.checked || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => { sentinel = null; });
    } catch {
      // z. B. Akkusparmodus oder Berechtigung verweigert — Toggle bleibt einfach wirkungslos
    }
  }

  function release() {
    sentinel?.release().catch(() => {});
    sentinel = null;
  }

  toggle.addEventListener('change', () => { toggle.checked ? acquire() : release(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') acquire(); });
  acquire();
}

/**
 * PWA-Installierbarkeit: der Service Worker (sw.js) sorgt zusammen mit
 * manifest.webmanifest dafür, dass Browser das Installations-Angebot
 * überhaupt machen — ein eigener Button ist zusätzlicher Komfort
 * (`beforeinstallprompt` selbst abfangen, statt nur auf das browsereigene
 * Icon in der Adressleiste zu hoffen), keine Voraussetzung dafür.
 */
function setupInstallPrompt(button) {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    button.classList.remove('hidden');
  });
  button.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    button.disabled = true;
    await deferredPrompt.prompt();
    deferredPrompt = null;
    button.classList.add('hidden');
  });
  window.addEventListener('appinstalled', () => { button.classList.add('hidden'); });
}

/**
 * Ausgehendes Teilen: Web Share API, wo vorhanden (löst auf Handys direkt
 * das native Teilen-Menü aus — WhatsApp, SMS, …) — sonst bleibt das
 * `<input readonly>` daneben die Fallback-Bedienung (antippen/klicken
 * markiert den Text, siehe `onclick="this.select()"` in index.html), kein
 * eigener Copy-Button nötig. Auf mehrere Buttons anwendbar (Setup-Ansicht
 * UND die kompakte Variante im Spiel selbst).
 */
function setupShareButtons(buttons, { title, text, getUrl }) {
  const canShare = 'share' in navigator;
  for (const button of buttons) {
    if (!canShare) continue; // ohne Web Share API bleibt nur das Link-Feld selbst — button.hidden Default aus index.html greift
    button.classList.remove('hidden');
    button.addEventListener('click', () => {
      navigator.share({ title, text, url: getUrl() }).catch(() => {}); // vom Nutzer abgebrochen — kein Fehlerfall
    });
  }
}

/**
 * Eingehendes Teilen: `manifest.webmanifest`s `share_target` liefert einen
 * von einer anderen App geteilten Link als `?url=`/`?text=` (GET-Query,
 * siehe Manifest) statt als Hash — hier wird daraus wieder die Route, die
 * der Rest dieser Datei erwartet (`#<gameId>`), und die Query-String-Spur
 * per `history.replaceState` aus der Adressleiste entfernt (kein Reload,
 * kein erneuter Eintrag in der Browser-History).
 */
function resolveIncomingShare() {
  if (location.search) {
    const params = new URLSearchParams(location.search);
    const sharedHash = [params.get('url'), params.get('text'), params.get('title')]
      .filter(Boolean)
      .map((candidate) => candidate.match(/#([0-9a-f-]{36})/i)?.[1])
      .find(Boolean);
    history.replaceState(null, '', location.pathname + (sharedHash ? `#${sharedHash}` : location.hash));
  }
  return parseHashRoute(location.hash);
}

async function main() {
  setupWakeLock(wakeLockToggle);
  setupInstallPrompt(installBtn);

  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  const { spaceId: gameId } = resolveIncomingShare();

  // Ein neues Spiel bekommt seine Id erst zur Laufzeit (`qu.createSpace()`,
  // siehe README Abschnitt 3/APP-GUIDE Schritt 3) — deshalb hier
  // `pushTopics: ['']` ("push alles, was ich selbst schreibe") statt eines
  // festen Präfixes, das die Id vorher kennen müsste. Verbinden MUSS bereits
  // vor createGame() passieren, sonst landet das Manifest nie beim Relay
  // und ein zweites Gerät (oder dieselbe Seite nach einem erneuten Öffnen)
  // sieht nie mehr als eine leere, lokale Kopie.
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
      history.replaceState(null, '', location.pathname + buildHashRoute(newGameId));
      await openGame(newGameId);
    });
    return;
  }

  await openGame(gameId);

  async function openGame(id) {
    setupBox.classList.add('hidden');
    statusEl.textContent = 'Synchronisiere …';
    await repl.sync({ topic: id, since: 0 });
    statusEl.textContent = 'Verbunden';

    const shareUrl = `${location.origin}${location.pathname}${buildHashRoute(id)}`;
    shareLinkEl.value = shareUrl;
    shareBox.classList.remove('hidden');
    gameBox.classList.remove('hidden');
    document.body.classList.add('in-game'); // schaltet auf die Vollbild-Handy-Ansicht (index.html)
    setupShareButtons([shareBtn, shareBtnInGame], {
      title: 'QU Verfolgungsjagd',
      text: 'Mach mit bei unserer Verfolgungsjagd:',
      getUrl: () => shareLinkEl.value,
    });

    const config = await getConfig(qu, id);
    if (!config) {
      statusEl.textContent = 'Fehler: Spiel nicht gefunden (falscher Link oder noch nicht synchronisiert)';
      document.body.classList.remove('in-game');
      return;
    }

    intervalLabelEl.textContent = String(Math.round(config.pingIntervalMs / 60_000));

    watchStatus(qu, id, (state) => setStatusBadge(state));

    const hunted = await isHunted(qu, id);
    const hunter = await isHunter(qu, id);

    if (hunted) {
      huntedControls.classList.remove('hidden');
      setupHuntedControls(qu, id, config);
    }
    if (hunter || !hunted) {
      // Fänger-Team ODER ein reiner Beobachter (Link ohne eigene Team-Rolle) —
      // beide bekommen dieselbe Karten-Ansicht; nur der "Team gefunden"-Button
      // bleibt unten auf echte Fänger beschränkt.
      hunterControls.classList.remove('hidden');
      caughtBtn.classList.toggle('hidden', !hunter);
      if (hunter) caughtBtn.addEventListener('click', () => declareCaught(qu, id));
      await setupMap(qu, id, config);
    }
  }
}

// --- Gejagtes Team: Geolocation + periodisches Pingen ---
function setupHuntedControls(qu, gameId, config) {
  let watchId = null;
  let intervalId = null;
  let countdownId = null;
  let currentPosition = null;
  let tracking = false;
  let lastPingAt = null;

  async function sendPing() {
    if (!currentPosition) return;
    const { latitude: lat, longitude: lon, accuracy, speed } = currentPosition.coords;
    await pingLocation(qu, gameId, { lat, lon, accuracy, speedMps: speed ?? null });
    lastPingAt = Date.now();
    lastPingInfoEl.textContent = `Zuletzt gemeldet: ${new Date(lastPingAt).toLocaleTimeString()} (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
  }

  function renderCountdown() {
    if (!lastPingAt) { nextPingInfoEl.textContent = ''; return; }
    const remaining = Math.max(0, config.pingIntervalMs - (Date.now() - lastPingAt));
    nextPingInfoEl.textContent = remaining > 0 ? `Nächste Meldung in ${fmtDuration(remaining / 1000)}` : 'Meldung läuft …';
  }

  trackBtn.addEventListener('click', () => {
    if (tracking) {
      navigator.geolocation.clearWatch(watchId);
      clearInterval(intervalId);
      clearInterval(countdownId);
      tracking = false;
      trackBtn.textContent = 'Tracking starten';
      trackBtn.classList.remove('tracking');
      nextPingInfoEl.textContent = '';
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
    countdownId = setInterval(renderCountdown, 1000);
    tracking = true;
    trackBtn.textContent = 'Tracking stoppen';
    trackBtn.classList.add('tracking');
  });
}

// --- Fänger-Team/Beobachter: Karte mit Weg, vorausberechnetem Radius,
// eigener Position und Distanz-Feedback ("wärmer"/"kälter"). Reaktiv über
// watchPings() (hunt-lib.mjs, gebaut auf viewObject()) — kein separates
// "einmal laden", jeder Marker entsteht/aktualisiert sich ausschließlich
// über dessen createItem()/render(). ---
async function setupMap(qu, gameId, config) {
  const map = L.map(mapEl, { zoomControl: true }).setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap-Mitwirkende',
    maxZoom: 19,
  }).addTo(map);

  const path = L.polyline([], { color: '#7dd3fc' }).addTo(map);
  const markersLayer = L.layerGroup().addTo(map);
  const radiusCircle = L.circle([0, 0], { radius: 0, color: '#f87171', fillOpacity: 0.08, dashArray: '6 6' }).addTo(map);
  const ownMarker = L.circleMarker([0, 0], { radius: 7, color: '#c084fc', fillColor: '#c084fc', fillOpacity: 0.9 });
  const connectorLine = L.polyline([], { color: '#c084fc', weight: 2, dashArray: '3 6' });

  let pings = []; // in Ankunftsreihenfolge, chronologisch (siehe watchPings()/viewObject()'s eigene ts-Sortierung des Anfangsbestands)
  let ownPosition = null; // { lat, lon } — nur lokal, wird nie an den Space geschrieben
  let hasFitted = false;

  function currentBounds() {
    const points = pings.map((q) => [q.value.lat, q.value.lon]);
    if (ownPosition) points.push([ownPosition.lat, ownPosition.lon]);
    return points;
  }

  function updateRadius() {
    const prediction = predictNextRadius(pings, config, Date.now());
    if (!prediction) {
      radiusValueEl.textContent = '–';
      ageValueEl.textContent = '–';
      radiusCircle.setRadius(0);
      return;
    }
    radiusCircle.setLatLng([prediction.center.lat, prediction.center.lon]);
    radiusCircle.setRadius(prediction.radiusMeters);
    // Leiser Puls auf dem Kreis (Füllstärke oszilliert) — ein glanceable
    // Lebenszeichen der Seite, ganz ohne dass irgendwer etwas antippen muss.
    const pulse = 0.05 + 0.05 * Math.abs(Math.sin(Date.now() / 900));
    radiusCircle.setStyle({ fillOpacity: pulse });
    radiusValueEl.textContent = fmtDistance(prediction.radiusMeters);
    ageValueEl.textContent = fmtDuration(prediction.elapsedS);
  }

  function updateOwnPosition() {
    if (!ownPosition || !pings.length) {
      proximityValueEl.textContent = '–';
      proximityTileEl.className = 'stat-tile';
      return;
    }
    const last = pings[pings.length - 1];
    const distance = haversineMeters(ownPosition, { lat: last.value.lat, lon: last.value.lon });
    connectorLine.setLatLngs([[ownPosition.lat, ownPosition.lon], [last.value.lat, last.value.lon]]);
    proximityValueEl.textContent = fmtDistance(distance);
    const prediction = predictNextRadius(pings, config, Date.now());
    // "Heiß"/"warm"/"kalt": innerhalb des vorausberechneten Radius (schon
    // eingeholt), knapp daneben (< 3x Radius), oder noch weit weg —
    // reine Anzeige-Klassifikation, ändert nichts an predictNextRadius() selbst.
    const radius = prediction?.radiusMeters ?? 0;
    proximityTileEl.className = 'stat-tile ' + (distance <= radius ? 'hot' : distance <= radius * 3 ? 'warm' : 'cold');
  }

  let previousCurrentMarker = null;
  watchPings(qu, gameId, config, {
    createItem(q) {
      const marker = L.circleMarker([q.value.lat, q.value.lon], { radius: 5, color: '#7dd3fc', fillOpacity: 0.9 });
      marker.bindPopup(new Date(q.ts).toLocaleTimeString());
      marker.addTo(markersLayer);
      return marker;
    },
    render(marker, value, q) {
      previousCurrentMarker?.setStyle({ radius: 5, color: '#7dd3fc' }); // die bisher "aktuelle" Position wird wieder ein normaler Weg-Punkt
      marker.setStyle({ radius: 8, color: '#4ade80' });
      previousCurrentMarker = marker;

      pings.push(q);
      path.setLatLngs(pings.map((p) => [p.value.lat, p.value.lon]));
      if (!hasFitted && currentBounds().length) {
        map.fitBounds(currentBounds(), { maxZoom: 16, padding: [30, 30] });
        hasFitted = true;
      }
      updateRadius();
      updateOwnPosition();
      // Nur ein wirklich FRISCHER Ping vibriert — der Anfangsbestand (schon
      // bekannte Pings beim Öffnen der Karte) soll nicht als eine Salve
      // Vibrationen ankommen. `q.ts` selbst (statt einer Zeit-seit-Aufruf-
      // Heuristik) entscheidet das, weil er unabhängig davon stimmt, wie
      // lange die anfängliche Synchronisierung gedauert hat.
      if (navigator.vibrate && Date.now() - q.ts < 5000) navigator.vibrate([80, 40, 80]);
    },
  });

  setInterval(updateRadius, 1000); // Radius wächst live weiter, auch ohne neuen Ping

  // Eigene Position ist rein lokal (nie an den Space geschrieben) — nur
  // fürs Zentrieren/die Distanzanzeige. Best-effort: bei Ablehnung/Fehler
  // bleibt die Karte einfach ohne eigenen Marker nutzbar.
  try {
    navigator.geolocation.watchPosition(
      (pos) => {
        const wasFirst = !ownPosition;
        ownPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        ownMarker.setLatLng([ownPosition.lat, ownPosition.lon]);
        if (wasFirst) { ownMarker.addTo(map); connectorLine.addTo(map); hasFitted = false; }
        updateOwnPosition();
        if (!hasFitted && currentBounds().length) { map.fitBounds(currentBounds(), { maxZoom: 16, padding: [30, 30] }); hasFitted = true; }
      },
      () => {}, // kein eigener Standort verfügbar — Karte bleibt trotzdem nutzbar
      { enableHighAccuracy: true },
    );
  } catch {
    // Geolocation nicht verfügbar — ignorieren, reine Zusatzfunktion
  }
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  document.body.classList.remove('in-game');
  console.error(e);
});
