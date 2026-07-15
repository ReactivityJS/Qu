// Beispiel 7: ein 1:1-Privat-Chat ("Kontakt = Fingerprint") auf Basis der
// bereits im Core vorhandenen Chat-Primitive (src/modules/chat.js:
// sendMessage/onMessage, markRead/getReadReceipts, setPresence/getPresence).
// Diese Datei enthält nur, was OHNE `window`/`localStorage` testbar ist:
// Raum-Adressierung, Formatierung, Link-Erkennung, Einladungslinks. Der
// Browser-Teil (Identität, Kontaktliste in localStorage, Lightbox, Emoji-
// Picker, DOM-Rendering) liegt in app.mjs — derselbe Schnitt wie überall
// sonst im Repo (space-app-lib.mjs vs. space-app-browser.js).
//
// Kernidee: ein 1:1-Raum ist derselbe generische Space wie ein Forum-Board
// (Whitepaper §8), nur mit EINER aus beiden Fingerprints deterministisch
// abgeleiteten Id statt einer zufälligen (modules/spaces.js's
// `createSpaceAt(id, opts)`) — so finden zwei Kontakte denselben Raum,
// ohne vorher einen Link austauschen zu müssen; nur der jeweils andere
// Fingerprint (ohnehin Voraussetzung, um überhaupt schreiben zu dürfen)
// wird gebraucht.

const FINGERPRINT_RE = /^[0-9a-f]{24}$/i;

/** Ist `value` ein plausibler QU-Fingerprint (24 Hex-Zeichen, core/identity.js)? */
export function isValidFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value.trim());
}

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
 * Der "Briefkasten"-Space eines Fingerprints — bewusst OHNE eigenes
 * Manifest angelegt (bleibt dauerhaft im Bootstrap-Zustand von
 * modules/spaces.js: "kein Manifest = jeder darf schreiben"), damit JEDE
 * andere Identität dorthin einen Hinweis ablegen kann, ohne vorher vom
 * Empfänger als Schreiber autorisiert worden zu sein — das ist genau der
 * Mechanismus, der einen remote gestarteten Chat beim Empfänger auftauchen
 * lässt, ohne dass der zuerst selbst denselben Kontakt hinzufügen müsste
 * (siehe app.mjs's ensureRoom()/Inbox-Abo).
 */
export function inboxId(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('[chat-lib] inboxId() braucht einen gültigen Fingerprint');
  return `inbox-${fp}`;
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

/** 'image' | 'video' | 'audio' | 'file' — bestimmt, welcher Player/welche Vorschau für einen Anhang gerendert wird. */
export function mediaKind(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Kontakte nach letzter Aktivität absteigend (zuletzt geschrieben zuerst) — `lastTs` fehlend/0 landet ans Ende, stabil nach Alias sortiert. */
export function sortContactsByActivity(contacts) {
  return contacts.slice().sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0) || (a.alias ?? '').localeCompare(b.alias ?? ''));
}

/** Baut einen teilbaren Einladungslink (`<baseUrl>#add=<fingerprint>`) — die "Kontakt per Fingerprint hinzufügen"-Bequemlichkeit oben drauf: Fingerprint bleibt die eigentliche Identität, der Link ist nur Transportmittel. */
export function buildInviteLink(baseUrl, fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('[chat-lib] buildInviteLink() braucht einen gültigen Fingerprint');
  return `${baseUrl}#add=${fp}`;
}

/** Gegenstück zu buildInviteLink() — liest `#add=<fingerprint>` aus einem Hash, `null` falls keiner/kein gültiger vorhanden ist. */
export function parseInviteHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  const match = /^add=(.+)$/.exec(raw);
  return match ? normalizeFingerprint(decodeURIComponent(match[1])) : null;
}

/**
 * Der Direktlink zu EINEM Chat: `#<fingerprint>` — bewusst ein anderes
 * Format als buildInviteLink()s `#add=<fingerprint>` (eindeutig am
 * `add=`-Präfix unterscheidbar, siehe parseChatHash()/parseInviteHash()):
 * eine Einladung fragt erst nach ("Kontakt hinzufügen?"), ein Chat-Link
 * öffnet direkt — dieselbe Unterscheidung wie überall sonst im Repo
 * zwischen "ansehen" und "einer Aktion zustimmen".
 */
export function buildChatHashRoute(fingerprint) {
  const fp = normalizeFingerprint(fingerprint);
  if (!fp) throw new Error('[chat-lib] buildChatHashRoute() braucht einen gültigen Fingerprint');
  return `#${fp}`;
}

/** Gegenstück zu buildChatHashRoute() — liest einen blanken Fingerprint-Hash (NICHT `#add=...`, das bleibt parseInviteHash()s Sache), `null` falls leer/kein gültiger Fingerprint. */
export function parseChatHash(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw || raw.startsWith('add=')) return null;
  return normalizeFingerprint(raw);
}
