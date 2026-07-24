// Reine, DOM-freie Logik für examples/people — derselbe Schnitt wie
// examples/chat/chat-lib.mjs vs. app.mjs (space-app-lib.mjs vs.
// space-app-browser.js): alles hier ist ohne `window`/`localStorage`
// testbar, Rendering/Identität/Netzwerk liegt in app.mjs.

const FINGERPRINT_RE = /^[0-9a-f]{24}$/i;

/** Ist `value` ein plausibler QU-Fingerprint (24 Hex-Zeichen, core/identity.js)? Dieselbe Prüfung wie examples/chat/chat-lib.mjs's isValidFingerprint() — hier dupliziert statt geteilt, siehe dessen Datei-Doku zum bewussten Nicht-Teilen von App-lib-Dateien untereinander. */
export function isValidFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value.trim());
}

/** Case-insensitive Teilstring-Suche über Alias UND Fingerprint — mindestens eines der beiden muss treffen. Ein leerer/nur-Whitespace-Query trifft alles (keine Suche aktiv = ganzes Verzeichnis). */
export function matchesQuery(entry, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  return (entry.alias ?? '').toLowerCase().includes(q) || entry.fingerprint.toLowerCase().includes(q);
}

/** Verzeichnis-Einträge alphabetisch nach Alias (case-insensitive), stabil nach Fingerprint sortiert, wenn zwei Aliasse gleich lauten. */
export function sortDirectory(entries) {
  return entries.slice().sort((a, b) => (a.alias ?? '').localeCompare(b.alias ?? '') || a.fingerprint.localeCompare(b.fingerprint));
}
