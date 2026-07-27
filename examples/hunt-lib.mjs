// Beispiel: "Geo Chase" — ein gejagtes Team meldet in einem festen
// Intervall (Default 2 Minuten) seinen Standort, ein oder mehrere
// Fänger-Teams sehen die Punkte (und damit den nachgezeichneten Weg) auf
// einer Karte und versuchen, das gejagte Team zu finden und in Reichweite
// zu fangen. Reine Logik hier, ohne Browser/Karte — die Oberfläche
// (Leaflet-Karte, Geolocation) liegt in examples/hunt/app.mjs.
//
// Modell: EIN Space pro Spiel (Whitepaper §8), genau wie jede andere
// Space-App in diesem Repo (siehe space-app-lib.mjs). Alle Teams stehen in
// `writers` — nicht weil alle dieselben Rechte im Sinne der App-Logik
// hätten, sondern weil ein Space genau EINE Writer-Liste kennt (§8.3) und
// "wer darf WAS schreiben" App-Konvention ist, keine ACL-Grenze: das
// gejagte Team schreibt unter `pings/`, Fänger-Teams (optional) unter
// `hunterPings/`, alle gemeinsam unter `status`. Genau das Muster, das
// presence.js's Moduldoku für `reads/${fp}` beschreibt — der Pfad ist
// Adressierung, das verifizierte `writer`-Feld ist die Wahrheit, und jede
// Leseseite hier filtert danach (siehe listPings()/watchPings()/
// watchHunterPings()), nicht nach dem Pfad allein — insbesondere
// `hunterTeamOf()`/`isHunter()` bestimmen die Team-Zugehörigkeit IMMER aus
// dem Konfig-Manifest, nie aus einem selbst behaupteten Feld im Ping.
//
// Zeit-Sharding (README §7) ist hier bewusst NICHT nötig: ein Ping-Intervall
// von Minuten statt Millisekunden hält `pings/`/`hunterPings/` strukturell
// klein (ein mehrstündiges Spiel mit 5-Minuten-Takt sind < 100 Einträge je
// Collection), anders als eine für immer wachsende Forum-Collection.
//
// Live-Ansichten (watchStatus()/watchPings()/watchHunterPings() unten)
// bauen bewusst auf `viewKey()`/`viewObject()` (src/ui/bindings.js, hier
// über den Barrel `src/index.js` importiert, DOM-frei und genauso in Node
// testbar wie der Rest dieser Datei) statt auf einem handgestrickten
// `.on()`/`.map()` samt eigenem "einmal lesen, dann separat abonnieren"-
// Vorlauf — exakt das Muster, das docs/lab/labs/05-references-practice.mjs
// für seine Live-Bibliothek zeigt: KEIN "Neu laden"-Aufruf irgendwo, eine
// einzige Subscription liefert bereits Vorhandenes UND künftige Änderungen.
import { viewKey, viewObject } from '../src/index.js';

// Exportiert (nicht nur modulintern), damit die UI (examples/hunt/app.mjs)
// ihre Formular-Vorgaben von HIER liest statt sie ein zweites Mal als
// hartkodierten HTML-Attributwert zu duplizieren — eine einzige Quelle für
// "was ein neues Spiel ohne explizite Angabe annimmt".
export const DEFAULT_PING_INTERVAL_MS = 2 * 60_000;
export const DEFAULT_HUNTER_PING_INTERVAL_MS = 4 * 60_000; // nur relevant, wenn das Feature "Fänger auf der Karte" aktiviert wird
export const DEFAULT_ASSUMED_SPEED_MPS = 1.4; // ruhiges Gehtempo, als Fallback ohne Bewegungshistorie
export const DEFAULT_CATCH_RADIUS_M = 50; // wie nah ein Fänger dem gejagten Team sein muss, um "gefangen" erklären zu dürfen

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
 * Legt ein neues Spiel an: ein Space, dessen Writer das gejagte Team UND
 * alle Fänger-Teams sind (s.o.), `readers: ['*']` per Default (Link =
 * Zugang, wie beim offenen Forum-Board) — für ein privates Spiel eine
 * konkrete Liste übergeben. `hunterTeams`: `[{ label, members: [fp,...] }]`.
 *
 * Jedes Konfig-Feld ist eine EIGENE Leaf-QuBit unter `config/<feld>`
 * (`config/pingIntervalMinutes`, nicht ein einzelnes `config`-Objekt mit
 * allen Feldern zusammen) — genau das "jedes Feld seine eigene Leaf-QuBit"-
 * Prinzip, das bindings.js/README für unabhängig beobachtbare Felder
 * empfiehlt. Der Grund ist hier kein Schreibkonflikt (wie beim
 * ursprünglichen Anwendungsfall in bindObject()), sondern Lesbarkeit:
 * examples/hunt/index.html bindet `<qu-view key="config/pingIntervalMinutes">`
 * direkt an genau dieses eine Feld — ein zusammengesetztes Objekt könnte ein
 * `<qu-view>` nicht sinnvoll direkt anzeigen (siehe ui/components.js'
 * Doku: "ein Item, dessen Felder in EINER kombinierten QuBit liegen ... hat
 * keine rein deklarative Antwort"). Minuten (nicht Millisekunden) sind hier
 * bewusst die gespeicherte Einheit — das ist genau die Zahl, die sowohl das
 * Formular entgegennimmt als auch die Anzeige zeigen soll, keine Umrechnung
 * nötig, um sie dazustellen. `hunterTeams` ist aus demselben Grund eine
 * wachsende Collection (`hunterTeams/<teamId>/label` + `.../members`, per
 * `set()`-artigem generiertem `teamId` statt eines einzelnen Array-Felds) —
 * das macht `<qu-list path="hunterTeams">` direkt im Template möglich (siehe
 * ui/components.js' `<qu-list>`-Doku).
 *
 * Rückgabe: die Space-Id (für den Einladungslink an alle Teams).
 */
export async function createGame(qu, {
  huntedTeam = [qu.fingerprint],
  hunterTeams = [],
  readers = ['*'],
  pingIntervalMs = DEFAULT_PING_INTERVAL_MS,
  assumedSpeedMps = DEFAULT_ASSUMED_SPEED_MPS,
  // Feature "Fänger auf der Karte": aus (null/0) per Default — ein Spiel,
  // bei dem auch die Fänger ihre eigene Position preisgeben, ist eine
  // bewusste Zusatzregel, keine Voreinstellung.
  hunterPingIntervalMs = null,
  // Nur sinnvoll (und in der UI nur sichtbar), wenn hunterPingIntervalMs
  // gesetzt ist — dem gejagten Team den Abstand zum nächsten Fänger zeigen.
  showDistanceToHunted = false,
  catchRadiusMeters = DEFAULT_CATCH_RADIUS_M,
  label = null,
} = {}) {
  const allHunterFps = hunterTeams.flatMap((t) => t.members ?? []);
  // Der/die Erzeuger:in (Admin, s.u.) braucht selbst Schreibrecht für
  // `config`/`status`, auch falls sie/er keinem der Teams angehört (z. B.
  // eine Spielleitung, die das Spiel nur aufsetzt) — anders als beim
  // User-Space (~fingerprint) trägt ein generischer Space (hier: das Spiel)
  // seinen Ersteller nicht automatisch in `writers` ein (nur in `admins`,
  // siehe modules/spaces.js's createSpaceACLResolver()).
  const writers = [...new Set([qu.fingerprint, ...huntedTeam, ...allHunterFps])];
  const space = qu.createSpace({ writers, readers });
  await space.ready;

  await space.get('huntedTeam').put(huntedTeam);
  await space.get('config/pingIntervalMinutes').put(Math.round(pingIntervalMs / 60_000));
  await space.get('config/assumedSpeedMps').put(assumedSpeedMps);
  await space.get('config/catchRadiusMeters').put(catchRadiusMeters);
  await space.get('config/hunterPingIntervalMinutes').put(hunterPingIntervalMs ? Math.round(hunterPingIntervalMs / 60_000) : null);
  await space.get('config/showDistanceToHunted').put(showDistanceToHunted);
  await space.get('config/label').put(label);
  for (const t of hunterTeams) {
    const teamId = crypto.randomUUID();
    await space.get(`hunterTeams/${teamId}/label`).put(t.label || 'Fänger-Team');
    await space.get(`hunterTeams/${teamId}/members`).put(t.members ?? []);
  }
  // Ein einzelner String, kein `{ state, by }`-Objekt: WER den Status
  // gesetzt hat, steht bereits verifiziert im Qubit selbst (`.writer`,
  // siehe Session/Verify) — ein zusätzliches `by`-Feld wäre nur eine
  // redundante, ungeprüfte Kopie derselben Information (dasselbe Prinzip,
  // das presence.js's Moduldoku für `q.writer` statt Pfad-Vertrauen nennt).
  await space.get('status').put('active');
  return space.id;
}

/**
 * `{ huntedTeam, hunterTeams, pingIntervalMs, assumedSpeedMps,
 * hunterPingIntervalMs, showDistanceToHunted, catchRadiusMeters, label }` —
 * `null`, falls (noch) nicht sichtbar. Baut das zusammengesetzte Bild aus
 * den einzelnen Leaf-QuBits zusammen (siehe createGame()-Doku), für Code,
 * der (anders als ein `<qu-view>` im Template) eine fertige Konfiguration
 * auf einmal braucht (predictNextRadius(), declareCaught(), …) — Minuten
 * werden hier zurück in Millisekunden gewandelt, die interne Einheit, die
 * der Rest dieser Datei (setInterval-taugliche Werte) erwartet.
 */
export async function getConfig(qu, gameId) {
  const huntedTeamQ = await qu.get(`${gameId}/huntedTeam`);
  if (!huntedTeamQ) return null; // Space (für diesen Client) noch nicht sichtbar
  const [pingIntervalMinutesQ, assumedSpeedMpsQ, catchRadiusMetersQ, hunterPingIntervalMinutesQ, showDistanceToHuntedQ, labelQ, hunterTeams] = await Promise.all([
    qu.get(`${gameId}/config/pingIntervalMinutes`),
    qu.get(`${gameId}/config/assumedSpeedMps`),
    qu.get(`${gameId}/config/catchRadiusMeters`),
    qu.get(`${gameId}/config/hunterPingIntervalMinutes`),
    qu.get(`${gameId}/config/showDistanceToHunted`),
    qu.get(`${gameId}/config/label`),
    listHunterTeams(qu, gameId),
  ]);
  return {
    huntedTeam: huntedTeamQ.value,
    hunterTeams,
    pingIntervalMs: (pingIntervalMinutesQ?.value ?? DEFAULT_PING_INTERVAL_MS / 60_000) * 60_000,
    assumedSpeedMps: assumedSpeedMpsQ?.value ?? DEFAULT_ASSUMED_SPEED_MPS,
    catchRadiusMeters: catchRadiusMetersQ?.value ?? DEFAULT_CATCH_RADIUS_M,
    hunterPingIntervalMs: hunterPingIntervalMinutesQ?.value ? hunterPingIntervalMinutesQ.value * 60_000 : null,
    showDistanceToHunted: showDistanceToHuntedQ?.value ?? false,
    label: labelQ?.value ?? null,
  };
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

/** Reine Funktion auf einer bereits geladenen `config` — welches Fänger-Team (falls überhaupt eins) `fingerprint` angehört, oder `null`. Team-Zugehörigkeit kommt IMMER hieraus, nie aus einem selbst behaupteten Feld in einem Ping (siehe Moduldoku oben). */
export function hunterTeamOf(config, fingerprint) {
  return config?.hunterTeams?.find((t) => t.members.includes(fingerprint)) ?? null;
}

/** Ist `qu` Mitglied irgendeines Fänger-Teams in diesem Spiel? */
export async function isHunter(qu, gameId) {
  const config = await getConfig(qu, gameId);
  return hunterTeamOf(config, qu.fingerprint) !== null;
}

/**
 * Alle Fänger-Teams (`[{ id, label, members }]`) — für eine Team-Übersicht
 * in der UI (`<qu-list path="hunterTeams">` im Browser, siehe
 * createGame()-Doku; diese Funktion ist das Node-taugliche Gegenstück
 * für Code, das die ganze Liste auf einmal braucht). Jedes Team ist zwei
 * Leaf-QuBits (`hunterTeams/<teamId>/label` + `.../members`) — hier wieder
 * zu einem Objekt pro Team zusammengefasst, exakt das Muster, das
 * `<qu-list>`s eigene `itemIdOf()`/`deep: true`-Gruppierung intern auch
 * verwendet (ui/components.js). Leer, falls der Space (noch) nicht
 * sichtbar ist.
 */
export async function listHunterTeams(qu, gameId) {
  const prefix = `${gameId}/hunterTeams`;
  const rows = await qu.session.query(`${prefix}/**`);
  const byId = new Map();
  for (const q of rows) {
    const [teamId, field] = q.id.slice(prefix.length + 1).split('/');
    const entry = byId.get(teamId) ?? { id: teamId, label: 'Fänger-Team', members: [] };
    entry[field] = q.value;
    byId.set(teamId, entry);
  }
  return [...byId.values()];
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

/**
 * Ein Standort-Ping eines Fänger-Teams — nur relevant, wenn das Spiel
 * `hunterPingIntervalMs` gesetzt hat (Feature "Fänger auf der Karte"), aber
 * strukturell unabhängig davon erzwungen: jedes Mitglied EINES der
 * `hunterTeams` darf pingen, unabhängig davon, ob die UI das Feature
 * anbietet. Wie bei pingLocation() set(), aus demselben Grund (§7.2).
 */
export async function pingHunterLocation(qu, gameId, { lat, lon, accuracy = null, speedMps = null }) {
  if (!(await isHunter(qu, gameId))) throw new Error('Nur ein Mitglied eines Fänger-Teams darf seinen Standort melden');
  return qu.get(`${gameId}/hunterPings`).set({ lat, lon, accuracy, speedMps });
}

/**
 * Live-Ansicht auf die Pings ALLER Fänger-Teams zusammen — dieselbe Form
 * wie watchPings(), nur mit dem Fremdschreiber-Filter "Mitglied irgendeines
 * `hunterTeams`-Eintrags" statt "Mitglied des gejagten Teams". Welchem
 * konkreten Team ein einzelner Ping zuzuordnen ist, kann ein Aufrufer selbst
 * über `hunterTeamOf(config, q.writer)` in `render()` bestimmen — diese
 * Funktion trifft dazu bewusst keine Vorauswahl, damit ein und dieselbe
 * Ansicht sowohl "alle Fänger einzeln" als auch "alle Fänger nach Team
 * eingefärbt" bedienen kann. Sichtbar für jede:n, der/die den Space lesen
 * darf (typischerweise ALLE Teilnehmenden inkl. gejagtem Team) — dieses
 * Beispiel unterscheidet bewusst nicht "nur das eigene Fänger-Team sieht
 * sich selbst" vs. "auch rivalisierende Teams sehen sich gegenseitig", um
 * den Umfang überschaubar zu halten.
 *
 * `key` wird unverändert an `viewObject()` durchgereicht (Default dort:
 * `(q) => q.id`, ein Item pro Ping) — ein Aufrufer, der lieber EINEN
 * beweglichen Marker pro Fänger statt eines Marker-Pfads will, übergibt
 * `key: (q) => q.writer`: derselbe Fänger bekommt dann bei jedem neuen Ping
 * ein `render()` auf sein bereits bestehendes Item, statt ein neues.
 */
export function watchHunterPings(qu, gameId, config, { createItem, render, key }) {
  const hunterFps = new Set((config?.hunterTeams ?? []).flatMap((t) => t.members));
  return viewObject(qu.get(`${gameId}/hunterPings`), {
    createItem: (q) => (hunterFps.has(q.writer) ? createItem(q) : null),
    render(item, value, q) {
      if (item !== null) render(item, value, q);
    },
    ...(key ? { key } : {}),
  });
}

/**
 * Reine Geometrie: kürzeste Distanz von `position` zu irgendeinem Eintrag
 * in `hunterPings` (Qubits wie von watchHunterPings()/listPings() geliefert)
 * — die Grundlage für die "Abstand zu den Fängern"-Anzeige beim gejagten
 * Team (Feature `showDistanceToHunted`). `null`, wenn `position` fehlt oder
 * noch kein Fänger-Ping vorliegt.
 */
export function nearestHunterDistance(position, hunterPings) {
  if (!position || !hunterPings?.length) return null;
  let nearest = Infinity;
  for (const q of hunterPings) {
    const d = haversineMeters(position, { lat: q.value.lat, lon: q.value.lon });
    if (d < nearest) nearest = d;
  }
  return nearest;
}

/**
 * Das Fänger-Team hat das gejagte Team gefunden — beendet das Spiel, aber
 * NUR, wenn `hunterPosition` (der eigene, aktuelle Standort der/des
 * aufrufenden Fängers/in, z. B. aus einem laufenden `watchPosition()`) sich
 * innerhalb `config.catchRadiusMeters` des letzten bekannten Pings des
 * gejagten Teams befindet (Feature "Fangradius") — diese Prüfung sitzt
 * bewusst HIER, nicht nur als deaktivierter Button in der UI, damit die
 * Regel unabhängig von der jeweiligen Oberfläche gilt (siehe Moduldoku
 * "immer API-basiert"). Echte GPS-Fälschung lässt sich clientseitig nicht
 * ausschließen (kein kryptographischer Ortsbeweis) — für ein
 * Freizeit-Spiel unter sich vertrauenden Teams ist die Prüfung selbst
 * trotzdem der Punkt, kein Sicherheitsversprechen gegen Betrug.
 */
export async function declareCaught(qu, gameId, hunterPosition) {
  if (!(await isHunter(qu, gameId))) throw new Error('Nur ein Mitglied eines Fänger-Teams darf das Spiel für gefangen erklären');
  const last = await lastPing(qu, gameId);
  if (!last) throw new Error('Noch kein Standort des gejagten Teams bekannt');
  if (!hunterPosition) throw new Error('Eigener Standort nicht verfügbar — Reichweite kann nicht geprüft werden');
  const config = await getConfig(qu, gameId);
  const radius = config?.catchRadiusMeters ?? DEFAULT_CATCH_RADIUS_M;
  const distance = haversineMeters(hunterPosition, { lat: last.value.lat, lon: last.value.lon });
  if (distance > radius) throw new Error(`Zu weit entfernt vom gejagten Team (${Math.round(distance)} m, erlaubt: ${Math.round(radius)} m)`);
  return qu.get(`${gameId}/status`).put('caught');
}

/** Spiel regulär beenden/abbrechen (z. B. durch das gejagte Team, oder weil ein Zeitlimit erreicht ist), ohne dass jemand gefangen wurde. */
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
