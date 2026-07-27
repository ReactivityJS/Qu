// Beispiel: "Geo Chase" — ein gejagtes Team meldet in einem festen
// Intervall (Default 5 Minuten) seinen Standort, ein Fänger-Team sieht die
// Punkte (und damit den nachgezeichneten Weg) auf einer Karte und versucht,
// das gejagte Team zu finden. Reine Logik hier, ohne Browser/Karte — die
// Oberfläche (Leaflet-Karte, Geolocation) liegt in examples/hunt/app.mjs.
//
// Modell: EIN Space pro Spiel (Whitepaper §8), genau wie jede andere
// Space-App in diesem Repo (siehe space-app-lib.mjs). Beide Teams stehen in
// `writers` — nicht weil beide dieselben Rechte im Sinne der App-Logik
// hätten, sondern weil ein Space genau EINE Writer-Liste kennt (§8.3) und
// "wer darf WAS schreiben" App-Konvention ist, keine ACL-Grenze: das
// gejagte Team schreibt unter `pings/`, das Fänger-Team unter `catchClaims/`
// (bzw. beide unter `status`, um das Spiel zu beenden). Genau das Muster,
// das presence.js's Moduldoku für `reads/${fp}` beschreibt — der Pfad ist
// Adressierung, das verifizierte `writer`-Feld ist die Wahrheit, und jede
// Leseseite hier filtert danach (siehe listPings()/watchPings()), nicht
// nach dem Pfad allein.
//
// Zeit-Sharding (README §7) ist hier bewusst NICHT nötig: ein Ping-Intervall
// von Minuten statt Millisekunden hält `pings/` strukturell klein (ein
// mehrstündiges Spiel mit 5-Minuten-Takt sind < 100 Einträge), anders als
// eine für immer wachsende Forum-Collection.
//
// Live-Ansichten (watchStatus()/watchPings() unten) bauen bewusst auf
// `viewKey()`/`viewObject()` (src/ui/bindings.js, hier über den Barrel
// `src/index.js` importiert, DOM-frei und genauso in Node testbar wie der
// Rest dieser Datei) statt auf einem handgestrickten `.on()`/`.map()` samt
// eigenem "einmal lesen, dann separat abonnieren"-Vorlauf — exakt das
// Muster, das docs/lab/labs/05-references-practice.mjs für seine
// Live-Bibliothek zeigt: KEIN "Neu laden"-Aufruf irgendwo, eine einzige
// Subscription liefert bereits Vorhandenes UND künftige Änderungen.
import { viewKey, viewObject } from '../src/index.js';

const DEFAULT_PING_INTERVAL_MS = 5 * 60_000;
const DEFAULT_ASSUMED_SPEED_MPS = 1.4; // ruhiges Gehtempo, als Fallback ohne Bewegungshistorie

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Abstand zweier {lat, lon}-Punkte in Metern (Haversine) — keine QU-Abhängigkeit, reine Geometrie. */
export function haversineMeters(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Legt ein neues Spiel an: ein Space, dessen Writer beide Teams sind
 * (s.o.), `readers: ['*']` per Default (Link = Zugang, wie beim
 * offenen Forum-Board) — für ein privates Spiel eine konkrete Liste
 * übergeben. Rückgabe: die Space-Id (für den Einladungslink an beide Teams).
 */
export async function createGame(qu, {
  huntedTeam = [qu.fingerprint],
  hunterTeam = [],
  readers = ['*'],
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
  assumedSpeedMps = DEFAULT_ASSUMED_SPEED_MPS,
  label = null,
} = {}) {
  // Der/die Erzeuger:in (Admin, s.u.) braucht selbst Schreibrecht für
  // `config`/`status`, auch falls sie/er keinem der beiden Teams angehört
  // (z. B. eine Spielleitung, die das Spiel nur aufsetzt) — anders als beim
  // User-Space (~fingerprint) trägt ein generischer Space (hier: das Spiel)
  // seinen Ersteller nicht automatisch in `writers` ein (nur in `admins`,
  // siehe modules/spaces.js's createSpaceACLResolver()).
  const writers = [...new Set([qu.fingerprint, ...huntedTeam, ...hunterTeam])];
  const space = qu.createSpace({ writers, readers });
  await space.ready;
  await space.get('config').put({ huntedTeam, hunterTeam, pingIntervalMs, assumedSpeedMps, label });
  // Ein einzelner String, kein `{ state, by }`-Objekt: WER den Status
  // gesetzt hat, steht bereits verifiziert im Qubit selbst (`.writer`,
  // siehe Session/Verify) — ein zusätzliches `by`-Feld wäre nur eine
  // redundante, ungeprüfte Kopie derselben Information (dasselbe Prinzip,
  // das presence.js's Moduldoku für `q.writer` statt Pfad-Vertrauen nennt).
  await space.get('status').put('active');
  return space.id;
}

/** `{ huntedTeam, hunterTeam, pingIntervalMs, assumedSpeedMps, label }` — `null`, falls (noch) nicht sichtbar. */
export async function getConfig(qu, gameId) {
  const q = await qu.get(`${gameId}/config`);
  return q?.value ?? null;
}

/** `'active'|'caught'|'ended'` — `null`, falls (noch) nicht sichtbar. */
export async function getStatus(qu, gameId) {
  const q = await qu.get(`${gameId}/status`);
  return q?.value ?? null;
}

/**
 * Live-Ansicht auf den Spielstatus: `render(state, qubit)` läuft einmal
 * sofort mit dem aktuellen Stand (falls schon vorhanden) und danach bei
 * jeder Änderung erneut — `viewKey()` selbst übernimmt sowohl das
 * "erst lesen, dann abonnieren" als auch das Verwerfen doppelt
 * zugestellter Qubits (gleicher `ts`, z. B. eigenes Echo). Rückgabe: eine
 * Unsubscribe-Funktion.
 */
export function watchStatus(qu, gameId, render) {
  return viewKey(qu.get(`${gameId}/status`), render);
}

/** Ist `qu` Mitglied des gejagten Teams in diesem Spiel? */
export async function isHunted(qu, gameId) {
  const config = await getConfig(qu, gameId);
  return config?.huntedTeam?.includes(qu.fingerprint) ?? false;
}

/** Ist `qu` Mitglied des Fänger-Teams in diesem Spiel? */
export async function isHunter(qu, gameId) {
  const config = await getConfig(qu, gameId);
  return config?.hunterTeam?.includes(qu.fingerprint) ?? false;
}

/**
 * Ein Standort-Ping des gejagten Teams — set(), weil mehrere Mitglieder des
 * gejagten Teams unabhängig voneinander pingen können (kollisionssicher,
 * §7.2) und die Reihenfolge über den Qubit-eigenen `ts` kommt, nicht über
 * einen selbstgebauten Zeitstempel. `speedMps`/`accuracy` sind optional
 * (z. B. `position.coords.speed`/`.accuracy` der Geolocation-API im Browser)
 * und fließen in predictNextRadius() ein, falls vorhanden.
 */
export async function pingLocation(qu, gameId, { lat, lon, accuracy = null, speedMps = null }) {
  if (!(await isHunted(qu, gameId))) throw new Error('Nur das gejagte Team darf Standort-Pings senden');
  return qu.get(`${gameId}/pings`).set({ lat, lon, accuracy, speedMps });
}

/** Alle Pings des gejagten Teams, älteste zuerst — Fremdschreiber (nicht im gejagten Team) werden gefiltert, siehe Moduldoku oben. */
export async function listPings(qu, gameId) {
  const config = await getConfig(qu, gameId);
  const hunted = new Set(config?.huntedTeam ?? []);
  const rows = await qu.session.query(`${gameId}/pings/**`);
  return rows.filter((q) => hunted.has(q.writer)).sort((a, b) => a.ts - b.ts);
}

/**
 * Live-Ansicht auf die Pings des gejagten Teams, gebaut auf `viewObject()`
 * (siehe Moduldoku oben) statt auf einem rohen `.map()`: liefert jeden schon
 * bekannten Ping sofort (`createItem`+`render` laufen dafür einmal) und
 * jeden künftigen genauso über dieselbe eine Subscription — kein separater
 * "einmal laden"-Aufruf nötig, bevor dieser hier läuft. `config` wird
 * bewusst als Parameter erwartet (statt selbst nachgeladen): der
 * Fremdschreiber-Filter (Moduldoku oben) braucht `config.huntedTeam` schon
 * beim allerersten, synchron zugestellten Ping, und jeder Aufrufer hat
 * `config` an dieser Stelle ohnehin schon (z. B. für predictNextRadius())
 * — ein interner Nachlade-Cache hier wäre nur eine zweite Quelle für
 * genau dieselbe, bereits vorhandene Information.
 *
 * `createItem(q)`/`render(item, value, q)` haben dieselbe Bedeutung wie bei
 * `viewObject()` selbst — diese Funktion fügt nur den Fremdschreiber-Filter
 * hinzu, sonst nichts. Rückgabe: eine Unsubscribe-Funktion.
 */
export function watchPings(qu, gameId, config, { createItem, render }) {
  const hunted = new Set(config?.huntedTeam ?? []);
  return viewObject(qu.get(`${gameId}/pings`), {
    // Ein Fremdschreiber bekommt gar kein Item (nicht nur ein ungerendertes)
    // — `null` markiert das für render() unten, ohne dass der Aufrufer
    // seinerseits auf `null` prüfen müsste.
    createItem: (q) => (hunted.has(q.writer) ? createItem(q) : null),
    render(item, value, q) {
      if (item !== null) render(item, value, q);
    },
  });
}

/** Der letzte bekannte Ping, oder `null`, falls noch keiner vorliegt. */
export async function lastPing(qu, gameId) {
  const pings = await listPings(qu, gameId);
  return pings.length ? pings[pings.length - 1] : null;
}

/** Das Fänger-Team hat das gejagte Team gefunden — beendet das Spiel. */
export async function declareCaught(qu, gameId) {
  return qu.get(`${gameId}/status`).put('caught');
}

/** Spiel regulär beenden (z. B. Zeitlimit erreicht), ohne dass jemand gefangen wurde. */
export async function endGame(qu, gameId) {
  return qu.get(`${gameId}/status`).put('ended');
}

/**
 * Die "Hilfe" aus der Aufgabenstellung: ein voraussichtlicher Radius um den
 * LETZTEN bekannten Ping, in dem sich das gejagte Team inzwischen befinden
 * könnte — reine Funktion auf bereits geladenen Pings (siehe listPings()),
 * kein eigener QU-Zugriff, damit sie sich unabhängig testen lässt.
 *
 * Geschwindigkeit: NICHT nur aus dem LETZTEN Intervall (ein einzelner
 * Ausreißer — eine Rast, ein kurzer Sprint — würde die Vorhersage sonst
 * verzerren, obwohl über die gesamte bisherige Strecke ein ganz anderes
 * Tempo üblich war), sondern aus zwei Größen über die GESAMTE
 * Ping-Historie: der DURCHSCHNITTLICHEN Geschwindigkeit (Gesamtstrecke /
 * Gesamtzeit, glättet einzelne Ausreißer weg) und der SCHNELLSTEN je
 * zwischen zwei aufeinanderfolgenden Pings beobachteten Geschwindigkeit
 * (fängt eine kurze, schnelle Etappe auf, die im Durchschnitt sonst
 * untergehen würde) — verwendet wird jeweils das GRÖSSERE von beiden. Der
 * Radius ist eine grobe OBERE Schätzung ("könnte hier drin sein"), kein
 * Pfad-Vorhersagealgorithmus: ein zu KLEINER Radius (weil zufällig gerade
 * die letzte oder die durchschnittliche Etappe langsam war) wäre für die
 * suchenden Jäger irreführender als ein zu großzügiger. Nur mit einem
 * einzigen Ping (keine Bewegungshistorie) greift `config.assumedSpeedMps`
 * als Fallback. Der Radius selbst ist `geschwindigkeit * seit-dem-letzten-
 * Ping-vergangene-Zeit`, zuzüglich einer eventuellen GPS-Ungenauigkeit
 * (`accuracy` des letzten Pings) als Sicherheitsmarge.
 */
export function predictNextRadius(pings, config, now = Date.now()) {
  if (!pings.length) return null;
  const last = pings[pings.length - 1];
  const elapsedS = Math.max(0, (now - last.ts) / 1000);

  let speedMps = last.value.speedMps ?? config?.assumedSpeedMps ?? DEFAULT_ASSUMED_SPEED_MPS;
  if (pings.length >= 2) {
    let totalDistM = 0;
    let totalDtS = 0;
    let peakSpeedMps = 0;
    for (let i = 1; i < pings.length; i++) {
      const prev = pings[i - 1];
      const cur = pings[i];
      const dtS = (cur.ts - prev.ts) / 1000;
      if (dtS <= 0) continue; // gleichzeitige/rückdatierte Pings (Uhr-Drift) tragen nichts zur Geschwindigkeit bei
      const distM = haversineMeters({ lat: prev.value.lat, lon: prev.value.lon }, { lat: cur.value.lat, lon: cur.value.lon });
      totalDistM += distM;
      totalDtS += dtS;
      peakSpeedMps = Math.max(peakSpeedMps, distM / dtS);
    }
    if (totalDtS > 0) {
      const avgSpeedMps = totalDistM / totalDtS;
      speedMps = Math.max(avgSpeedMps, peakSpeedMps);
    }
  }

  const radiusMeters = speedMps * elapsedS + (last.value.accuracy ?? 0);
  return { center: { lat: last.value.lat, lon: last.value.lon }, radiusMeters, speedMps, elapsedS };
}
