// Beispiel 7: ein privater Chat (1:1 UND Gruppe — ein "Chat" ist ein Raum
// mit einem ODER MEHREREN Mitgliedern, kein Sonderfall pro Mitgliederzahl)
// auf Basis der bereits im Core vorhandenen Chat-Primitive
// (src/modules/chat.js: sendMessage/onMessage, markRead/getReadReceipts,
// setPresence/getPresence). Diese Datei enthält nur, was OHNE `window`/
// `localStorage` testbar ist: Raum-Adressierung, Formatierung,
// Link-Erkennung, Einladungslinks. Der Browser-Teil (Identität,
// Kontakt-/Raumliste in localStorage, Lightbox, Emoji-Picker,
// DOM-Rendering) liegt in app.mjs — derselbe Schnitt wie überall sonst im
// Repo (space-app-lib.mjs vs. space-app-browser.js).
//
// Kernidee: EIN Raum ist derselbe generische Space wie ein Forum-Board
// (Whitepaper §8), egal ob 1:1 oder Gruppe — nur die Art, wie seine Id
// entsteht, unterscheidet sich: ein 1:1 (dmRoomId()) leitet sie
// deterministisch aus den zwei beteiligten Fingerprints ab (so finden
// zwei Kontakte denselben Raum, ohne vorher einen Link austauschen zu
// müssen), eine Gruppe (groupRoomId()) bekommt eine zufällige Id wie
// jeder andere neu erstellte Space (modules/spaces.js's
// `createSpaceAt(id, opts)`), weil ihre Mitgliederliste sich über die
// Zeit ändern kann und es daher keine feste "Ableitung" gäbe. Die
// Discovery/Mitgliederschaft selbst (Briefkasten, inboxId()) ist NICHT
// chat-spezifisch und lebt daher in src/modules/space-membership.js —
// derselbe Mechanismus, den jede andere Space-basierte App (ToDo, Forum,
// CMS) genauso braucht.

// Kanonische Definition + Regex liegen in core/identity.js — hier nur
// re-exportiert (wie examples/people/people-lib.mjs es schon vormacht),
// keine eigene Kopie mehr. Als Import statt reinem `export ... from`, weil
// normalizeFingerprint() unten selbst darauf aufbaut.
import { isValidFingerprint } from '../../src/core/identity.js';
export { isValidFingerprint };

/** Trimmt/normalisiert eine per Hand eingefügte Fingerprint-Eingabe (Groß-/Kleinschreibung, Whitespace) — `null`, falls das Ergebnis kein gültiger Fingerprint ist. */
export function normalizeFingerprint(input) {
  const clean = String(input ?? '').trim().toLowerCase();
  return isValidFingerprint(clean) ? clean : null;
}

/**
 * Deterministische 1:1-Raum-Id aus zwei Fingerprints — unabhängig davon,
 * wer sie in welcher Reihenfolge übergibt (sortiert), damit beide Seiten
 * immer auf demselben Space landen. Wirft, falls einer der beiden kein
 * gültiger Fingerprint ist (ein DM mit sich selbst wird bewusst nicht
 * ausgeschlossen — "Notiz an mich" ist ein gültiger Anwendungsfall).
 */
export function dmRoomId(fingerprintA, fingerprintB) {
  const a = normalizeFingerprint(fingerprintA);
  const b = normalizeFingerprint(fingerprintB);
  if (!a || !b) throw new Error('[chat-lib] dmRoomId() braucht zwei gültige Fingerprints');
  const [x, y] = [a, b].sort();
  return `dm-${x}-${y}`;
}

/**
 * Zufällige Gruppen-Raum-Id. Anders als dmRoomId() gibt es hier keine aus
 * den Mitgliedern ABLEITBARE Id — eine Gruppe hat keine feste
 * Mitgliederzahl (die ändert sich ja gerade durch Hinzufügen/Entfernen),
 * es gibt also kein "die zwei/drei Fingerprints sortiert" wie bei einem
 * DM. Ein zufälliger, eindeutiger Bezeichner wie bei jedem anderen neu
 * erstellten Space (modules/spaces.js's createSpace()).
 */
export function groupRoomId() {
  return `grp-${crypto.randomUUID()}`;
}

/** Die ersten `n` Zeichen eines Fingerprints, für kompakte Anzeige (Avatar-Fallback, Kontaktliste). */
export function shortFp(fingerprint, n = 8) {
  return fingerprint ? fingerprint.slice(0, n) : '';
}

/** "3 Std." — grob gerundete Menschen-lesbare Byte-Größe für Anhänge. */
export function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

/** "14:05" — reine Uhrzeit für eine Nachrichtenzeile. Format ist absichtlich immer HH:MM, unabhängig vom Locale (kein Locale-Parameter nötig für eine Chat-Bubble). */
export function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "1:05" / "12:03" — verstrichene Anrufdauer aus Sekunden, kein führendes Stunden-Segment unter einer Stunde (wie jeder Telefon-Timer). */
export function fmtCallDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0 ? `${h}:${mm}:${String(sec).padStart(2, '0')}` : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** "Heute"/"Gestern"/"12.03.2026" — Tages-Trenner zwischen Nachrichtengruppen. `now` ist injizierbar, damit dies ohne Systemzeit-Abhängigkeit testbar bleibt. */
export function fmtDayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return 'Heute';
  if (diffDays === 1) return 'Gestern';
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

const URL_RE = /(https?:\/\/[^\s<>"]+)/gi;

/**
 * Zerlegt Nachrichtentext in Text-/Link-Segmente, damit die Oberfläche
 * URLs klickbar + mit einer einfachen Vorschau (Hostname) darstellen kann,
 * ohne selbst eine Regex zu pflegen. `[{ type: 'text', value }]` und/oder
 * `[{ type: 'link', value, hostname }]`, in Auftrittsreihenfolge.
 */
export function linkify(text) {
  const segments = [];
  let lastIndex = 0;
  for (const match of String(text ?? '').matchAll(URL_RE)) {
    const [url] = match;
    const index = match.index;
    if (index > lastIndex) segments.push({ type: 'text', value: text.slice(lastIndex, index) });
    let hostname = url;
    try { hostname = new URL(url).hostname; } catch { /* kein gültiges URL-Objekt -> Rohtext als Hostname anzeigen */ }
    segments.push({ type: 'link', value: url, hostname });
    lastIndex = index + url.length;
  }
  if (lastIndex < text.length) segments.push({ type: 'text', value: text.slice(lastIndex) });
  return segments;
}

/**
 * Baut einen teilbaren Karten-Link aus Koordinaten — welcher Anbieter
 * (OpenStreetMap/Google/Apple/eigene URL) kommt aus den App-Einstellungen
 * (map-provider-select, app.mjs). Der Link wird als normale Chat-Nachricht
 * verschickt und braucht daher KEINE eigene Nachrichten-/Renderer-Logik —
 * die bereits vorhandene Link-Vorschau (linkify()/buildLinkPreview() in
 * app.mjs) greift automatisch. `customTemplate` darf `{lat}`/`{lng}`
 * enthalten; fehlt es oder ist es leer, fällt "custom" auf OpenStreetMap
 * zurück statt eine kaputte URL zu bauen.
 */
export function buildLocationUrl(provider, lat, lng, customTemplate) {
  const latStr = String(lat);
  const lngStr = String(lng);
  if (provider === 'google') return `https://www.google.com/maps/search/?api=1&query=${latStr},${lngStr}`;
  if (provider === 'apple') return `https://maps.apple.com/?ll=${latStr},${lngStr}&q=Standort`;
  if (provider === 'custom' && customTemplate) return customTemplate.replaceAll('{lat}', latStr).replaceAll('{lng}', lngStr);
  return `https://www.openstreetmap.org/?mlat=${latStr}&mlon=${lngStr}#map=16/${latStr}/${lngStr}`;
}

/** 'image' | 'video' | 'audio' | 'file' — bestimmt, welcher Player/welche Vorschau für einen Anhang gerendert wird. */
export function mediaKind(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Chats (Räume — 1:1 UND Gruppen, siehe app.mjs's `rooms`) nach letzter
 * Aktivität absteigend (zuletzt geschrieben zuerst) — `lastTs` fehlend/0
 * landet ans Ende, stabil nach `alias` sortiert (bei einem Raum: sein
 * Anzeigename, von app.mjs vor dem Aufruf berechnet — ein DM zeigt den
 * Namen des einen anderen Mitglieds, eine Gruppe ihren eigenen Namen).
 */
export function sortByActivity(list) {
  return list.slice().sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || (a.alias ?? '').localeCompare(b.alias ?? ''));
}

/**
 * Pfadschema für die gesamte App — jeder Screen (Chatliste, ein Chat,
 * dessen Einstellungen, das eigene Profil, App-Einstellungen, Suche,
 * "Kontakt hinzufügen", "Neue Gruppe", …) ist ein `#/a/b/c`-Pfad, nie eine
 * Query-artige `#key=value`-Notation und nie ein reines `hidden`-Flag ohne
 * URL-Entsprechung. app.mjs's Router baut jede Navigation über buildPath()
 * und liest jeden `hashchange` über parsePathSegments() — der Hash IST der
 * Zustand ("welcher Screen ist offen"), nichts pflegt das getrennt davon.
 * Feste erste Segmente (`profile`, `settings`, `search`, `add-contact`,
 * `new-group`) kollidieren nie mit einer echten Raum-Id — die beginnt
 * immer mit `dm-` oder `grp-` (dmRoomId()/groupRoomId() oben).
 *
 * Ein geteilter Einladungslink ist kein Sonderformat mehr, sondern
 * einfach `buildPath('add-contact', fingerprint)` — dieselbe Route wie
 * der "+"-Button in der App, nur mit dem Fingerprint als zweitem Segment
 * vorausgefüllt.
 *
 * Nicht (mehr) hier definiert — dieselbe generische Pfad-Logik wird auch
 * von examples/people gebraucht, daher jetzt in src/ui/hash-router.js,
 * hier nur re-exportiert (kein Bruch für bestehende Imports aus dieser Datei).
 */
export { buildPath, parsePathSegments } from '../../src/ui/hash-router.js';
