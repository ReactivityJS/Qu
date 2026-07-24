// EIN Pfadschema für jede App, die ihre Bildschirme über `location.hash`
// adressiert — jeder Screen ist ein `#/a/b/c`-Pfad, nie eine Query-artige
// `#key=value`-Notation und nie ein reines `hidden`-Flag ohne
// URL-Entsprechung. Ursprünglich in examples/chat/chat-lib.mjs entstanden
// (siehe dessen Router-Doku in app.mjs), hierher verschoben, weil
// examples/people denselben Mechanismus unverändert braucht — kein
// Sonderfall pro App, nur generische Pfad-Segmente. Browser- UND
// Node-tauglich (kein `window`-Zugriff), also ohne Weiteres testbar.

/** `buildPath('add-contact', fp)` -> `#/add-contact/<fp>` — jedes Segment einzeln URL-kodiert. */
export function buildPath(...segments) {
  return `#/${segments.map((s) => encodeURIComponent(s)).join('/')}`;
}

/** Gegenstück zu buildPath() — liest die Pfadsegmente eines `#/a/b/c`-Hashes, dekodiert. `[]` für einen leeren/nicht-Pfad-Hash (den Wurzel-Screen der jeweiligen App). */
export function parsePathSegments(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw.startsWith('/')) return [];
  return raw.slice(1).split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}
