// Beispiel (Oberfläche): siehe ../hunt-lib.mjs für die eigentliche Logik
// (Spiel/Ping/Radius-Vorhersage/Fangreichweite, gebaut auf
// viewKey()/viewObject()) — diese Datei ist nur die dünne UI-Schicht
// darüber (Leaflet-Karte, Geolocation, PWA-Installierbarkeit, Web Share),
// im selben Stil wie examples/forum/app.mjs.
//
// Reaktiv im Qu-Sinne heißt hier: KEIN Codepfad liest einmal und abonniert
// dann separat noch einmal, und keine zwei unabhängigen Stellen pflegen
// dieselbe Tatsache doppelt. Status, Ping-Intervalle und Teams sind direkt
// als `<qu-view>`/`<qu-list>` (src/ui/components.js) im Template gebunden
// (siehe index.html's <template>s + openGame() unten) — kein JS liest
// diese Werte, formatiert sie und schreibt sie in den DOM, das übernehmen
// die Komponenten selbst, direkt aus dem Space. Wo ein `<qu-view>` nicht
// reicht (Pings/Fänger-Positionen sind eine wachsende Collection mit
// Kartenmarkern statt eines einzelnen Textwerts), bauen watchPings()/
// watchHunterPings() (hunt-lib.mjs) auf `viewObject()` auf — dieselbe eine
// Subscription liefert bereits Vorhandenes UND künftige Änderungen, nie ein
// separates "einmal laden" davor. Auch die "Zuletzt gemeldet"-Anzeigen
// unten lesen NUR aus dieser einen Ping-Historie (pingsTracker/
// hunterPingsTracker), nicht aus einer zweiten, separat in sendPing()
// gepflegten Kopie derselben Tatsache. Und kein `location.reload()` als
// Ersatz für "jetzt mit einer neuen Id weitermachen" — ein frisch
// erstelltes Spiel geht direkt in openGame() über, ohne die Seite neu zu
// laden. Ein Reload passiert genau EINMAL bewusst: beim "Spiel beenden"
// des gejagten Teams — dort ist es keine Abkürzung, sondern die simpelste
// korrekte Art, alle laufenden Subscriptions/Geolocation-Watches/Wake
// Locks sauber loszuwerden und wirklich zum Startbildschirm zurückzukehren.
//
// Mobil-Fokus: sobald ein Spiel offen ist, füllt die Karte den gesamten
// verfügbaren Bildschirm (siehe index.html's `body.in-game`), Screen Wake
// Lock hält das Display an (kein Antippen nötig, um "am Leben" zu bleiben),
// und ein paar glanceable Live-Werte (Radius, Alter des letzten Pings,
// eigene Distanz) sollen die Seite auch ohne Interaktion spannend halten.
// Installierbar (manifest.webmanifest + sw.js) und teilbar (Web Share
// Target für eingehende Links, Web Share API für ausgehende) — siehe die
// jeweiligen Abschnitte unten. Sowohl das gejagte Team als auch jedes
// Fänger-Team (mehrere sind möglich) sehen dieselbe Karte — Orientierung
// ist für beide Seiten nützlich, nicht nur für die Fänger.
//
// Wichtige Grenze, die diese Datei NICHT löst (kein Web-API dafür
// existiert): echtes Tracking bei gesperrtem Display oder im Hintergrund.
// Wake Lock hält nur den Bildschirm an, solange der Tab selbst sichtbar
// ist — Browser (insbesondere mobile) drosseln/pausieren Timer und
// Geolocation zuverlässig, sobald die Seite in den Hintergrund wechselt
// oder das Display sperrt. Alle Teams müssen die Seite also aktiv im
// Vordergrund halten (siehe #screen-hint in index.html).

import { createWebSocketChannel, createNetworkPlugin, createSpacesPlugin } from '../../src/index.js';
import '../../src/ui/components.js'; // Seiteneffekt: registriert <qu-view>/<qu-bind>/<qu-list>
import {
  createGame, getConfig, isHunted, hunterTeamOf,
  pingLocation, watchPings, pingHunterLocation, watchHunterPings, nearestHunterDistance,
  declareCaught, endGame, predictNextRadius, haversineMeters,
  DEFAULT_PING_INTERVAL_MS, DEFAULT_HUNTER_PING_INTERVAL_MS, DEFAULT_ASSUMED_SPEED_MPS, DEFAULT_CATCH_RADIUS_M,
} from '../hunt-lib.mjs';
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { parseHashRoute, buildHashRoute } from '../space-app-lib.mjs';
import { createWakeLock } from '../../src/ui/wake-lock.mjs';

// Dieselbe Identität wie examples/chat/examples/people (siehe deren
// IDENTITY_KEY-Doku: bewusst EIN Fingerprint fürs gesamte Ökosystem, kein
// pro-App-Konto) — bis auf diesen einen String war das schon immer die
// gemeinsame Speicherstelle (loadOrCreateIdentity() -> space-app-browser.js's
// LocalStorageAdapter mit leerem Namespace), nur der eigene, abweichende
// Key hier hielt Hunt fälschlich isoliert. Sichtbar wurde das über
// examples/chat: ein dort per createGame() mit dem CHAT-Fingerprint als
// huntedTeam angelegtes Spiel zeigte JEDER öffnenden Person (auch der
// gejagten selbst) die Jäger-/Beobachter-Ansicht, weil Hunt beim Öffnen des
// Links eine ANDERE, hier isolierte Identität geladen hätte, deren
// Fingerprint nie in huntedTeam/hunterTeam vorkommen konnte (s.
// isHunted()/isHunter() in hunt-lib.mjs) — kein Konfigurations-/
// Zeitproblem, sondern zwei verschiedene Identitäten für dieselbe Person.
const IDENTITY_KEY = 'qu-identity';
const TEAM_COLORS = ['#f472b6', '#facc15', '#34d399', '#60a5fa', '#fb923c', '#a78bfa'];

const el = (id) => document.getElementById(id);
const statusEl = el('status');
const myFpEl = el('my-fp');
const setupBox = el('setup-box');
const pingIntervalInput = el('ping-interval');
const assumedSpeedInput = el('assumed-speed');
const catchRadiusInput = el('catch-radius');
const hunterTeamsListEl = el('hunter-teams-list');
const addTeamBtn = el('add-team-btn');
const hunterTeamRowTemplate = el('hunter-team-row-template');
const hunterTrackingEnabledCheckbox = el('hunter-tracking-enabled');
const hunterTrackingOptionsDiv = el('hunter-tracking-options');
const hunterPingIntervalInput = el('hunter-ping-interval');
const showDistanceToggle = el('show-distance-toggle');
const createGameBtn = el('create-game-btn');
const shareBox = el('share-box');
const shareLinkEl = el('share-link');
const shareBtn = el('share-btn');
const shareBtnInGame = el('share-btn-ingame');
const installBtn = el('install-btn');
const gameBox = el('game-box');
const gameStatusSlotEl = el('game-status-slot');
const teamsBox = el('teams-box');
const teamsToggle = el('teams-toggle');
const teamsContent = el('teams-content');
const huntedTeamSlotEl = el('hunted-team-slot');
const hunterTeamsSlotEl = el('hunter-teams-slot');
const huntedControls = el('hunted-controls');
const intervalLabelSlotEl = el('interval-label-slot');
const trackBtn = el('track-btn');
const lastPingInfoEl = el('last-ping-info');
const nextPingInfoEl = el('next-ping-info');
const huntedDistanceRow = el('hunted-distance-row');
const huntedDistanceValueEl = el('hunted-distance-value');
const endGameBtn = el('end-game-btn');
const hunterControls = el('hunter-controls');
const radiusValueEl = el('radius-value');
const ageValueEl = el('age-value');
const proximityTileEl = el('proximity-tile');
const proximityValueEl = el('proximity-value');
const caughtBtn = el('caught-btn');
const catchRangeInfoEl = el('catch-range-info');
const hunterTrackingControlsDiv = el('hunter-tracking-controls');
const hunterIntervalLabelSlotEl = el('hunter-interval-label-slot');
const hunterTrackBtn = el('hunter-track-btn');
const hunterLastPingInfoEl = el('hunter-last-ping-info');
const hunterNextPingInfoEl = el('hunter-next-ping-info');
const mapEl = el('map');
const wakeLockToggle = el('wakelock-toggle');

// Qu-Component-<template>s (siehe index.html) — erst NACH `gameBox.qu = ...`
// geklont/eingehängt, siehe openGame() unten und der Kommentar bei den
// <template>s selbst.
const statusBadgeTemplate = el('status-badge-template');
const intervalMinutesTemplate = el('interval-minutes-template');
const hunterIntervalMinutesTemplate = el('hunter-interval-minutes-template');
const huntedTeamTemplate = el('hunted-team-template');
const hunterTeamsListTemplate = el('hunter-teams-list-template');

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

function colorForTeam(config, teamId) {
  const idx = config.hunterTeams.findIndex((t) => t.id === teamId);
  return TEAM_COLORS[idx % TEAM_COLORS.length] ?? '#94a3b8';
}

/**
 * Hält den Bildschirm an, solange die Seite sichtbar UND der Toggle
 * eingeschaltet ist — der Sperrbildschirm selbst bleibt dadurch aus, was
 * auf vielen Geräten der einzig verlässliche Weg ist, Geolocation/Timer am
 * Laufen zu halten (siehe Moduldoku oben). Die eigentliche Sentinel-/
 * Re-Acquire-Mechanik (inkl. `visibilitychange`) sitzt jetzt in
 * `src/ui/wake-lock.mjs` — dieselbe Utility, die examples/chat/app.mjs für
 * sein referenzgezähltes "wach halten während einer Anhang-Übertragung"
 * verwendet, statt einer zweiten, eigenen Implementierung hier.
 */
function setupWakeLock(toggle) {
  const lock = createWakeLock();
  toggle.addEventListener('change', () => { toggle.checked ? lock.acquire() : lock.release(); });
  if (toggle.checked) lock.acquire();
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
 * Zwei verschiedene ankommende Query-Strings, beide behandelt statt eines
 * Hash-Wechsels (den ein `share_target`-Redirect verlöre, UND ein noch gar
 * nicht existierendes Spiel hätte ohnehin keine Id für einen Hash):
 *
 * 1. Eingehendes Teilen: `manifest.webmanifest`s `share_target` liefert
 *    einen von einer anderen App geteilten Link als `?url=`/`?text=`
 *    (GET-Query) — daraus wird wieder die Route, die der Rest dieser Datei
 *    erwartet (`#<gameId>`).
 * 2. Eine "neues Spiel"-Einladung von woanders (z. B. examples/chat's
 *    Geo-Chase-Button, s. dessen eigene Doku) als `?interval=<Minuten>`/
 *    `?speed=<m/s>` — bewusst NUR diese beiden lose gekoppelten Werte,
 *    keine tiefere Schnittstelle: der einladende Absender legt das Spiel
 *    NICHT selbst an (kein direkter Zugriff auf createGame()/den Space von
 *    außerhalb dieser App), sondern gibt nur Vorschläge fürs Formular mit;
 *    wer den Link öffnet, sieht sie als normale, weiter änderbare Eingabe-
 *    werte und erstellt das Spiel ganz regulär selbst über `createGameBtn`
 *    unten (wird dadurch automatisch Teil des gejagten Teams).
 *
 * Die Query-String-Spur wird in beiden Fällen per `history.replaceState`
 * aus der Adressleiste entfernt (kein Reload, kein neuer History-Eintrag).
 */
function resolveIncomingShare() {
  let prefill = null;
  if (location.search) {
    const params = new URLSearchParams(location.search);
    const sharedHash = [params.get('url'), params.get('text'), params.get('title')]
      .filter(Boolean)
      .map((candidate) => candidate.match(/#([0-9a-f-]{36})/i)?.[1])
      .find(Boolean);
    if (!sharedHash) {
      const interval = Number(params.get('interval'));
      const speed = Number(params.get('speed'));
      prefill = {
        pingIntervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : null,
        assumedSpeedMps: Number.isFinite(speed) && speed >= 0 ? speed : null,
      };
    }
    history.replaceState(null, '', location.pathname + (sharedHash ? `#${sharedHash}` : location.hash));
  }
  return { ...parseHashRoute(location.hash), prefill };
}

/**
 * Die EINE geteilte Geräteposition für die gesamte Seite — bewusst nur ein
 * einziger `watchPosition()`-Aufruf, unabhängig davon, wie viele Features
 * ihn gerade brauchen (Kartenmarker, Fangreichweiten-Prüfung, "Abstand zu
 * Fängern"-Anzeige, Pingen als gejagtes Team ODER als Fänger-Team) — nicht
 * nur Batterie-/GPS-Kontention sparen, sondern strukturell auch eine
 * einzige Quelle für "wo bin ich gerade" statt mehrerer unabhängiger,
 * potenziell leicht widersprüchlicher Erfassungen. Bewusst UNABHÄNGIG von
 * setupMap()/Leaflet — ein Leaflet-Ladefehler (z. B. CDN nicht erreichbar)
 * darf keines der anderen Features mit sich reißen. `onUpdate(cb)` ist
 * Zusatzangebot für setupMap() (den eigenen Marker live nachführen);
 * `getPosition()` allein reicht für alles andere.
 */
function startOwnPositionTracker() {
  let position = null;
  const listeners = new Set();
  try {
    navigator.geolocation.watchPosition(
      (pos) => {
        position = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, speedMps: pos.coords.speed ?? null };
        listeners.forEach((cb) => cb(position));
      },
      () => {}, // kein eigener Standort verfügbar — abhängige Features bleiben einfach ohne ihn nutzbar
      { enableHighAccuracy: true },
    );
  } catch {
    // Geolocation nicht verfügbar — position bleibt dauerhaft null
  }
  return {
    getPosition: () => position,
    onUpdate: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
}

/**
 * Reaktive Ping-Historie des gejagten Teams, bewusst UNABHÄNGIG von
 * setupMap()/Leaflet — genau wie startOwnPositionTracker() oben brauchen
 * die Fangreichweiten-Prüfung (setupCaughtButton()) und die "Abstand zu
 * Fängern"-Anzeige (setupHuntedControls()) diese Daten auch dann, wenn die
 * Karte selbst nicht laden konnte. Baut auf watchPings() (hunt-lib.mjs,
 * viewObject()) — kein separates "einmal laden" nötig. `onPing(cb)`
 * liefert beim Aufruf sofort JEDEN bereits bekannten Ping nach (dieselbe
 * "schon Vorhandenes + künftiges"-Garantie wie viewObject() selbst) und
 * danach jeden neuen — synchron und lückenlos, weil das Nachliefern und
 * das Eintragen in die Listener-Liste eine einzige, ununterbrochene
 * synchrone Operation sind.
 */
function trackPings(qu, gameId, config) {
  const pings = [];
  const listeners = new Set();
  watchPings(qu, gameId, config, {
    createItem: (q) => q,
    render(q) {
      pings.push(q);
      for (const cb of listeners) cb(q);
    },
  });
  return {
    getPings: () => pings,
    onPing(cb) {
      for (const q of pings) cb(q);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Dasselbe wie trackPings(), nur für alle Fänger-Teams zusammen — nur aktiv, wenn `config.hunterPingIntervalMs` gesetzt ist (Feature "Fänger auf der Karte"). */
function trackHunterPings(qu, gameId, config) {
  const hunterPings = [];
  const listeners = new Set();
  if (config.hunterPingIntervalMs) {
    watchHunterPings(qu, gameId, config, {
      key: (q) => q.writer,
      createItem: (q) => q.writer,
      render(writer, value, q) {
        hunterPings.push(q);
        for (const cb of listeners) cb(writer, q);
      },
    });
  }
  return {
    getHunterPings: () => hunterPings,
    onHunterPing(cb) {
      for (const q of hunterPings) cb(q.writer, q);
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// --- Setup-Formular: dynamische Liste von Fänger-Teams ---
function addHunterTeamRow(defaultLabel = '') {
  const clone = hunterTeamRowTemplate.content.cloneNode(true);
  const row = clone.querySelector('.hunter-team-row');
  row.querySelector('.team-label').value = defaultLabel;
  row.querySelector('.remove-team-btn').addEventListener('click', () => row.remove());
  hunterTeamsListEl.appendChild(row);
}

function collectHunterTeams() {
  return [...hunterTeamsListEl.querySelectorAll('.hunter-team-row')].map((row) => ({
    label: row.querySelector('.team-label').value.trim() || 'Fänger-Team',
    members: parseFingerprintList(row.querySelector('.team-members').value),
  }));
}

async function main() {
  setupWakeLock(wakeLockToggle);
  setupInstallPrompt(installBtn);
  addHunterTeamRow('Fänger-Team'); // ein Team ist der Normalfall — weitere per Button
  addTeamBtn.addEventListener('click', () => addHunterTeamRow());
  hunterTrackingEnabledCheckbox.addEventListener('change', () => {
    hunterTrackingOptionsDiv.classList.toggle('hidden', !hunterTrackingEnabledCheckbox.checked);
  });

  // Formular-Vorgaben kommen aus hunt-lib.mjs's DEFAULT_*-Konstanten, nicht
  // aus hartkodierten `value="…"`-Attributen in index.html (siehe dortiger
  // Kommentar) — eine einzige Quelle für "was ein neues Spiel ohne
  // Angabe annimmt".
  pingIntervalInput.value = String(DEFAULT_PING_INTERVAL_MS / 60_000);
  assumedSpeedInput.value = String(DEFAULT_ASSUMED_SPEED_MPS);
  catchRadiusInput.value = String(DEFAULT_CATCH_RADIUS_M);
  hunterPingIntervalInput.value = String(DEFAULT_HUNTER_PING_INTERVAL_MS / 60_000);

  const qu = (await loadOrCreateIdentity(IDENTITY_KEY)).use(createNetworkPlugin()).use(createSpacesPlugin());
  myFpEl.textContent = qu.fingerprint;

  const channel = createWebSocketChannel(relayUrl());
  await channel.connect();

  const { spaceId: gameId, prefill } = resolveIncomingShare();

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
    if (prefill?.pingIntervalMinutes != null) pingIntervalInput.value = String(prefill.pingIntervalMinutes);
    if (prefill?.assumedSpeedMps != null) assumedSpeedInput.value = String(prefill.assumedSpeedMps);
    setupBox.classList.remove('hidden');
    createGameBtn.addEventListener('click', async () => {
      createGameBtn.disabled = true;
      const hunterTeams = collectHunterTeams();
      const pingIntervalMs = Math.max(1, Number(pingIntervalInput.value) || DEFAULT_PING_INTERVAL_MS / 60_000) * 60_000;
      const assumedSpeedMps = Math.max(0, Number(assumedSpeedInput.value) || DEFAULT_ASSUMED_SPEED_MPS);
      const catchRadiusMeters = Math.max(1, Number(catchRadiusInput.value) || DEFAULT_CATCH_RADIUS_M);
      const hunterTrackingEnabled = hunterTrackingEnabledCheckbox.checked;
      const hunterPingIntervalMs = hunterTrackingEnabled ? Math.max(1, Number(hunterPingIntervalInput.value) || DEFAULT_HUNTER_PING_INTERVAL_MS / 60_000) * 60_000 : null;
      const showDistanceToHunted = hunterTrackingEnabled && showDistanceToggle.checked;
      const newGameId = await createGame(qu, {
        huntedTeam: [qu.fingerprint], hunterTeams, pingIntervalMs, assumedSpeedMps,
        catchRadiusMeters, hunterPingIntervalMs, showDistanceToHunted,
      });
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
      title: 'QU Geo Chase',
      text: 'Mach mit bei unserem Geo Chase:',
      getUrl: () => shareLinkEl.value,
    });

    const config = await getConfig(qu, id);
    if (!config) {
      statusEl.textContent = 'Fehler: Spiel nicht gefunden (falscher Link oder noch nicht synchronisiert)';
      document.body.classList.remove('in-game');
      return;
    }

    // `gameBox.qu` MUSS gesetzt sein, BEVOR irgendein <qu-view>/<qu-list>
    // darunter verbunden wird (siehe ui/components.js's Doku) — deshalb
    // werden die Qu-Component-<template>s aus index.html erst JETZT
    // geklont/eingehängt, nicht schon als statisches Markup beim Laden der
    // Seite. Status, Ping-Intervalle und Teams stehen danach rein
    // deklarativ da: kein watchStatus()/renderTeams()-Aufruf hier mehr,
    // <qu-view>/<qu-list> lesen/aktualisieren sich selbst.
    gameBox.qu = qu.get(id);
    gameStatusSlotEl.appendChild(statusBadgeTemplate.content.cloneNode(true));
    intervalLabelSlotEl.appendChild(intervalMinutesTemplate.content.cloneNode(true));
    huntedTeamSlotEl.appendChild(huntedTeamTemplate.content.cloneNode(true));
    hunterTeamsSlotEl.appendChild(hunterTeamsListTemplate.content.cloneNode(true));
    teamsBox.classList.remove('hidden');
    teamsToggle.addEventListener('click', () => teamsContent.classList.toggle('hidden'));

    const hunted = await isHunted(qu, id);
    const hunterTeam = hunterTeamOf(config, qu.fingerprint);
    const hunter = hunterTeam !== null;

    // Eigene Position + Ping-Historien: unabhängig von der Karte selbst
    // (siehe deren jeweilige Doku) — laufen auch weiter, falls Leaflet
    // gleich nicht laden sollte, weil Fangreichweiten-Prüfung/Distanz-
    // Anzeige/Tracking-Buttons keine erfolgreich gerenderte Karte brauchen,
    // nur diese Daten.
    const ownPositionTracker = startOwnPositionTracker();
    const pingsTracker = trackPings(qu, id, config);
    const hunterPingsTracker = trackHunterPings(qu, id, config);

    // Karte: für ALLE sichtbar (gejagtes Team, Fänger-Teams, Beobachter) —
    // Orientierung ist auch für das gejagte Team nützlich, nicht nur für
    // die Jäger. Rein visuelle Schicht über den drei Trackern oben — ein
    // Fehler beim Kartenaufbau (z. B. Leaflet-CDN nicht erreichbar) betrifft
    // dadurch nur die Kartendarstellung selbst.
    try {
      await setupMap(qu, id, config, ownPositionTracker, pingsTracker, hunterPingsTracker);
    } catch (e) {
      console.error('Karte konnte nicht geladen werden:', e);
    }

    if (hunted) {
      huntedControls.classList.remove('hidden');
      setupHuntedControls(qu, id, config, pingsTracker, hunterPingsTracker, ownPositionTracker);
      endGameBtn.addEventListener('click', async () => {
        endGameBtn.disabled = true;
        await endGame(qu, id);
        location.href = location.pathname; // zurück zum Startbildschirm — siehe Moduldoku oben zu diesem einen bewussten Reload
      });
    }
    if (hunter || !hunted) {
      // Fänger-Team ODER ein reiner Beobachter (Link ohne eigene Team-Rolle) —
      // beide bekommen dieselben Karten-Statistiken; nur der "Team
      // gefunden"-Button (und ein eigenes Standort-Teilen, falls das Spiel
      // das anbietet) bleiben auf ein echtes Fänger-Team-Mitglied beschränkt.
      hunterControls.classList.remove('hidden');
      caughtBtn.classList.toggle('hidden', !hunter);
      if (hunter) {
        setupCaughtButton(qu, id, config, pingsTracker, ownPositionTracker);
        if (config.hunterPingIntervalMs) {
          hunterTrackingControlsDiv.classList.remove('hidden');
          hunterIntervalLabelSlotEl.appendChild(hunterIntervalMinutesTemplate.content.cloneNode(true));
          setupHunterTrackingControls(qu, id, config, hunterPingsTracker, ownPositionTracker);
        }
      }
    }
  }
}

// --- Gejagtes Team: Geolocation + periodisches Pingen + optionale
// Abstands-Anzeige zu den Fängern (Feature `showDistanceToHunted`). ---
function setupHuntedControls(qu, gameId, config, pingsTracker, hunterPingsTracker, ownPositionTracker) {
  let intervalId = null;
  let countdownId = null;
  let tracking = false;
  let lastOwnPingTs = null;

  // "Zuletzt gemeldet" kommt AUSSCHLIESSLICH aus der bereits laufenden
  // Ping-Historie (pingsTracker, dieselbe Subscription, die auch die Karte
  // speist) — nicht aus einer zweiten, in sendPing() separat gepflegten
  // Kopie derselben Tatsache. Ein eigener Ping kommt so oder so über
  // dieselbe watchPings()-Subscription zurück (auch der eigene, siehe
  // deren viewObject()-Basis), es gibt also nichts, das hier zusätzlich
  // "gemerkt" werden müsste.
  pingsTracker.onPing((q) => {
    if (q.writer !== qu.fingerprint) return;
    lastOwnPingTs = q.ts;
    lastPingInfoEl.textContent = `Zuletzt gemeldet: ${new Date(q.ts).toLocaleTimeString()} (${q.value.lat.toFixed(5)}, ${q.value.lon.toFixed(5)})`;
  });

  async function sendPing() {
    const position = ownPositionTracker.getPosition();
    if (!position) return;
    await pingLocation(qu, gameId, { lat: position.lat, lon: position.lon, accuracy: position.accuracy, speedMps: position.speedMps });
  }

  function renderCountdown() {
    if (!lastOwnPingTs) { nextPingInfoEl.textContent = ''; return; }
    const remaining = Math.max(0, config.pingIntervalMs - (Date.now() - lastOwnPingTs));
    nextPingInfoEl.textContent = remaining > 0 ? `Nächste Meldung in ${fmtDuration(remaining / 1000)}` : 'Meldung läuft …';
  }

  trackBtn.addEventListener('click', () => {
    if (tracking) {
      clearInterval(intervalId);
      clearInterval(countdownId);
      tracking = false;
      trackBtn.textContent = 'Tracking starten';
      trackBtn.classList.remove('tracking');
      nextPingInfoEl.textContent = '';
      return;
    }
    // Nutzt den geteilten ownPositionTracker (siehe dessen Doku) statt
    // eines eigenen watchPosition()-Aufrufs — derselbe Standort, den auch
    // die Karte/der Fangreichweiten-Check verwenden.
    sendPing().catch((e) => { lastPingInfoEl.textContent = `Fehler: ${e.message}`; });
    intervalId = setInterval(() => { sendPing().catch((e) => { lastPingInfoEl.textContent = `Fehler: ${e.message}`; }); }, config.pingIntervalMs);
    countdownId = setInterval(renderCountdown, 1000);
    tracking = true;
    trackBtn.textContent = 'Tracking stoppen';
    trackBtn.classList.add('tracking');
  });

  if (config.showDistanceToHunted) {
    huntedDistanceRow.classList.remove('hidden');
    setInterval(() => {
      // Nutzt den unabhängigen ownPositionTracker (siehe dessen Doku) —
      // kein zweiter, redundanter watchPosition()-Aufruf nur für diese
      // Anzeige, und funktioniert auch, falls die Karte selbst nicht
      // geladen werden konnte.
      const distance = nearestHunterDistance(ownPositionTracker.getPosition(), hunterPingsTracker.getHunterPings());
      huntedDistanceValueEl.textContent = distance === null ? '–' : fmtDistance(distance);
    }, 1000);
  }
}

// --- Fänger-Team: "Team gefunden"-Button, nur innerhalb der Fangreichweite
// tatsächlich nutzbar (Feature `catchRadiusMeters`) — die eigentliche
// Prüfung sitzt in hunt-lib.mjs's declareCaught(), hier nur dieselbe Regel
// als Live-Feedback (deaktivierter Button + Distanzanzeige). ---
function setupCaughtButton(qu, gameId, config, pingsTracker, ownPositionTracker) {
  caughtBtn.addEventListener('click', async () => {
    caughtBtn.disabled = true;
    try {
      await declareCaught(qu, gameId, ownPositionTracker.getPosition());
      catchRangeInfoEl.textContent = '';
    } catch (e) {
      catchRangeInfoEl.textContent = e.message;
    } finally {
      caughtBtn.disabled = false;
    }
  });

  setInterval(() => {
    const own = ownPositionTracker.getPosition();
    const pings = pingsTracker.getPings();
    const last = pings[pings.length - 1];
    if (!own || !last) {
      catchRangeInfoEl.textContent = 'Eigener Standort oder Standort des gejagten Teams noch nicht bekannt.';
      caughtBtn.disabled = true;
      return;
    }
    const distance = haversineMeters(own, { lat: last.value.lat, lon: last.value.lon });
    const radius = config.catchRadiusMeters;
    if (distance <= radius) {
      catchRangeInfoEl.textContent = `In Fangreichweite (${Math.round(distance)} m von ${Math.round(radius)} m).`;
      caughtBtn.disabled = false;
    } else {
      catchRangeInfoEl.textContent = `Noch ${Math.round(distance - radius)} m bis zur Fangreichweite (${Math.round(radius)} m).`;
      caughtBtn.disabled = true;
    }
  }, 1000);
}

// --- Fänger-Team: eigenes Standort-Teilen, nur falls das Spiel
// `hunterPingIntervalMs` gesetzt hat (Feature "Fänger auf der Karte"). ---
function setupHunterTrackingControls(qu, gameId, config, hunterPingsTracker, ownPositionTracker) {
  let intervalId = null;
  let countdownId = null;
  let tracking = false;
  let lastOwnPingTs = null;

  // "Zuletzt geteilt" kommt AUSSCHLIESSLICH aus der bereits laufenden
  // Fänger-Ping-Historie (hunterPingsTracker) — dieselbe Begründung wie bei
  // setupHuntedControls() oben, keine zweite, separat gepflegte Kopie.
  hunterPingsTracker.onHunterPing((writer, q) => {
    if (writer !== qu.fingerprint) return;
    lastOwnPingTs = q.ts;
    hunterLastPingInfoEl.textContent = `Zuletzt geteilt: ${new Date(q.ts).toLocaleTimeString()}`;
  });

  async function sendPing() {
    const position = ownPositionTracker.getPosition();
    if (!position) return;
    await pingHunterLocation(qu, gameId, { lat: position.lat, lon: position.lon, accuracy: position.accuracy, speedMps: position.speedMps });
  }

  function renderCountdown() {
    if (!lastOwnPingTs) { hunterNextPingInfoEl.textContent = ''; return; }
    const remaining = Math.max(0, config.hunterPingIntervalMs - (Date.now() - lastOwnPingTs));
    hunterNextPingInfoEl.textContent = remaining > 0 ? `Nächste Meldung in ${fmtDuration(remaining / 1000)}` : 'Meldung läuft …';
  }

  hunterTrackBtn.addEventListener('click', () => {
    if (tracking) {
      clearInterval(intervalId);
      clearInterval(countdownId);
      tracking = false;
      hunterTrackBtn.textContent = 'Standort teilen: starten';
      hunterTrackBtn.classList.remove('tracking');
      hunterNextPingInfoEl.textContent = '';
      return;
    }
    // Nutzt den geteilten ownPositionTracker (siehe dessen Doku) statt
    // eines eigenen watchPosition()-Aufrufs.
    sendPing().catch((e) => { hunterLastPingInfoEl.textContent = `Fehler: ${e.message}`; });
    intervalId = setInterval(() => { sendPing().catch((e) => { hunterLastPingInfoEl.textContent = `Fehler: ${e.message}`; }); }, config.hunterPingIntervalMs);
    countdownId = setInterval(renderCountdown, 1000);
    tracking = true;
    hunterTrackBtn.textContent = 'Standort teilen: stoppen';
    hunterTrackBtn.classList.add('tracking');
  });
}

// --- Karte, für alle Rollen: Weg + vorausberechneter Radius des gejagten
// Teams, optional die Positionen der Fänger-Teams (Feature
// `hunterPingIntervalMs`), die eigene Position, Distanz-Feedback
// ("wärmer"/"kälter"). Rein visuelle Schicht über den drei bereits
// laufenden Trackern (ownPositionTracker/pingsTracker/hunterPingsTracker,
// siehe deren jeweilige Doku) — diese Funktion selbst hält keine eigenen
// Daten und ruft weder watchPings()/watchHunterPings() noch
// watchPosition() auf, nur `onPing()`/`onHunterPing()`/`onUpdate()` der
// bereits laufenden Tracker. ---
async function setupMap(qu, gameId, config, ownPositionTracker, pingsTracker, hunterPingsTracker) {
  const map = L.map(mapEl, { zoomControl: true }).setView([0, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap-Mitwirkende',
    maxZoom: 19,
  }).addTo(map);

  const path = L.polyline([], { color: '#7dd3fc' }).addTo(map);
  const markersLayer = L.layerGroup().addTo(map);
  const hunterMarkersLayer = L.layerGroup().addTo(map);
  const radiusCircle = L.circle([0, 0], { radius: 0, color: '#f87171', fillOpacity: 0.08, dashArray: '6 6' }).addTo(map);
  const ownMarker = L.circleMarker([0, 0], { radius: 7, color: '#c084fc', fillColor: '#c084fc', fillOpacity: 0.9 });
  const connectorLine = L.polyline([], { color: '#c084fc', weight: 2, dashArray: '3 6' });

  let ownPosition = ownPositionTracker.getPosition(); // { lat, lon } | null — nur lokal, wird nie an den Space geschrieben
  let hasFitted = false;

  function currentBounds() {
    const points = pingsTracker.getPings().map((q) => [q.value.lat, q.value.lon]);
    if (ownPosition) points.push([ownPosition.lat, ownPosition.lon]);
    return points;
  }

  function updateRadius() {
    const prediction = predictNextRadius(pingsTracker.getPings(), config, Date.now());
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
    const pings = pingsTracker.getPings();
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
  pingsTracker.onPing((q) => {
    const marker = L.circleMarker([q.value.lat, q.value.lon], { radius: 5, color: '#7dd3fc', fillOpacity: 0.9 });
    marker.bindPopup(new Date(q.ts).toLocaleTimeString());
    marker.addTo(markersLayer);

    previousCurrentMarker?.setStyle({ radius: 5, color: '#7dd3fc' }); // die bisher "aktuelle" Position wird wieder ein normaler Weg-Punkt
    marker.setStyle({ radius: 8, color: '#4ade80' });
    previousCurrentMarker = marker;

    path.setLatLngs(pingsTracker.getPings().map((p) => [p.value.lat, p.value.lon]));
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
  });

  // Fänger auf der Karte (Feature `hunterPingIntervalMs`, optional) — EIN
  // beweglicher Marker pro Fänger, kein Marker-Pfad wie beim gejagten Team:
  // hier interessiert nur die zuletzt geteilte Position.
  const hunterMarkerByWriter = new Map();
  hunterPingsTracker.onHunterPing((writer, q) => {
    const team = hunterTeamOf(config, writer);
    const color = team ? colorForTeam(config, team.id) : '#94a3b8';
    let marker = hunterMarkerByWriter.get(writer);
    if (!marker) {
      marker = L.circleMarker([q.value.lat, q.value.lon], { radius: 7, color, fillColor: color, fillOpacity: 0.85 });
      marker.bindTooltip(team?.label ?? 'Fänger');
      marker.addTo(hunterMarkersLayer);
      hunterMarkerByWriter.set(writer, marker);
    } else {
      marker.setLatLng([q.value.lat, q.value.lon]);
    }
  });

  setInterval(updateRadius, 1000); // Radius wächst live weiter, auch ohne neuen Ping

  // Eigene Position kommt vom geteilten ownPositionTracker (siehe
  // dessen Doku) — hier nur der eigene Marker/das Zentrieren als Reaktion
  // darauf, keine zweite Geolocation-Erfassung.
  if (ownPosition) { ownMarker.setLatLng([ownPosition.lat, ownPosition.lon]).addTo(map); connectorLine.addTo(map); updateOwnPosition(); }
  ownPositionTracker.onUpdate((position) => {
    const wasFirst = !ownPosition;
    ownPosition = position;
    ownMarker.setLatLng([ownPosition.lat, ownPosition.lon]);
    if (wasFirst) { ownMarker.addTo(map); connectorLine.addTo(map); hasFitted = false; }
    updateOwnPosition();
    if (!hasFitted && currentBounds().length) { map.fitBounds(currentBounds(), { maxZoom: 16, padding: [30, 30] }); hasFitted = true; }
  });
}

main().catch((e) => {
  statusEl.textContent = `Fehler: ${e.message}`;
  document.body.classList.remove('in-game');
  console.error(e);
});
