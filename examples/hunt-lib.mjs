// Beispiel: "Verfolgungsjagd" — ein gejagtes Team meldet in einem festen
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
// Leseseite hier filtert danach (siehe listPings()/onPing()), nicht nach
// dem Pfad allein.
//
// Zeit-Sharding (README §7) ist hier bewusst NICHT nötig: ein Ping-Intervall
// von Minuten statt Millisekunden hält `pings/` strukturell klein (ein
// mehrstündiges Spiel mit 5-Minuten-Takt sind < 100 Einträge), anders als
// eine für immer wachsende Forum-Collection.

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
  await space.get('status').put({ state: 'active' });
  return space.id;
}

/** `{ huntedTeam, hunterTeam, pingIntervalMs, assumedSpeedMps, label }` — `null`, falls (noch) nicht sichtbar. */
export async function getConfig(qu, gameId) {
  const q = await qu.get(`${gameId}/config`);
  return q?.value ?? null;
}

/** `{ state: 'active'|'caught'|'ended', ... }` — `null`, falls (noch) nicht sichtbar. */
export async function getStatus(qu, gameId) {
  const q = await qu.get(`${gameId}/status`);
  return q?.value ?? null;
}

export function onStatusChange(qu, gameId, callback, opts) {
  return qu.get(`${gameId}/status`).on(callback, opts);
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

/** Live-Abonnement auf neue Pings — derselbe Fremdschreiber-Filter wie listPings(). */
export function onPing(qu, gameId, callback, opts) {
  let hunted = null;
  return qu.get(`${gameId}/pings`).map(async (q) => {
    if (!hunted) hunted = new Set((await getConfig(qu, gameId))?.huntedTeam ?? []);
    if (hunted.has(q.writer)) callback(q);
  }, opts);
}

/** Der letzte bekannte Ping, oder `null`, falls noch keiner vorliegt. */
export async function lastPing(qu, gameId) {
  const pings = await listPings(qu, gameId);
  return pings.length ? pings[pings.length - 1] : null;
}

/** Das Fänger-Team hat das gejagte Team gefunden — beendet das Spiel. */
export async function declareCaught(qu, gameId) {
  return qu.get(`${gameId}/status`).put({ state: 'caught', by: qu.fingerprint });
}

/** Spiel regulär beenden (z. B. Zeitlimit erreicht), ohne dass jemand gefangen wurde. */
export async function endGame(qu, gameId) {
  return qu.get(`${gameId}/status`).put({ state: 'ended', by: qu.fingerprint });
}

/**
 * Die "Hilfe" aus der Aufgabenstellung: ein voraussichtlicher Radius um den
 * LETZTEN bekannten Ping, in dem sich das gejagte Team inzwischen befinden
 * könnte — reine Funktion auf bereits geladenen Pings (siehe listPings()),
 * kein eigener QU-Zugriff, damit sie sich unabhängig testen lässt.
 *
 * Geschwindigkeit: mit zwei oder mehr Pings wird die tatsächlich
 * zurückgelegte Strecke zwischen den letzten beiden Pings durch die
 * vergangene Zeit geteilt (beobachtete Geschwindigkeit) — nur mit einem
 * einzigen Ping (keine Bewegungshistorie) greift `config.assumedSpeedMps`
 * als Fallback. Der Radius selbst ist `geschwindigkeit * seit-dem-letzten-
 * Ping-vergangene-Zeit`, zuzüglich einer eventuellen GPS-Ungenauigkeit
 * (`accuracy` des letzten Pings) als Sicherheitsmarge — bewusst eine grobe
 * obere Schätzung ("könnte hier drin sein"), kein Pfad-Vorhersagealgorithmus.
 */
export function predictNextRadius(pings, config, now = Date.now()) {
  if (!pings.length) return null;
  const last = pings[pings.length - 1];
  const elapsedS = Math.max(0, (now - last.ts) / 1000);

  let speedMps = last.value.speedMps ?? config?.assumedSpeedMps ?? DEFAULT_ASSUMED_SPEED_MPS;
  if (pings.length >= 2) {
    const prev = pings[pings.length - 2];
    const dtS = (last.ts - prev.ts) / 1000;
    if (dtS > 0) {
      const distM = haversineMeters({ lat: prev.value.lat, lon: prev.value.lon }, { lat: last.value.lat, lon: last.value.lon });
      speedMps = distM / dtS;
    }
  }

  const radiusMeters = speedMps * elapsedS + (last.value.accuracy ?? 0);
  return { center: { lat: last.value.lat, lon: last.value.lon }, radiusMeters, speedMps, elapsedS };
}
