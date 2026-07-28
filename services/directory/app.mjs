// Verzeichnis — Reference-Implementierung des Mount-Vertrags aus
// services/README.md: ein `mount(container, {qu}) -> stopFn`-Export, sonst
// nichts. Wickelt nur die bereits bestehende <qu-people-search>-Komponente
// (src/ui/people-search-components.js) ein, dieselbe, die die Shell selbst
// schon auf ihrer Startseite verwendet — als eigener, im Nav-Dropdown
// gelisteter, direkt verlinkbarer Screen statt nur dort eingebettet.
//
// Kein `<name>-lib.mjs` nötig (siehe services/README.md's Vorlage) — hier
// steckt keine eigene Logik, nur Layout um eine bereits fertige,
// eigenständig getestete Komponente.

import '../../src/ui/people-search-components.js'; // Seiteneffekt: registriert <qu-people-search>

export function mount(container) {
  const heading = document.createElement('h2');
  heading.textContent = '🧭 Verzeichnis';
  const hint = document.createElement('p');
  hint.className = 'qu-directory-hint';
  hint.textContent = 'Nur Identitäten, die sich selbst sichtbar gemacht haben (eigenes Profil → „Im Verzeichnis sichtbar“).';
  const search = document.createElement('qu-people-search');
  search.setAttribute('mode', 'browse');
  search.setAttribute('fields', 'alias,fingerprint');
  // Literales `{fp}`-Template, nicht buildPath('u', '{fp}') — siehe
  // qu-app-shell.mjs's eigener Home-Screen-Kommentar zu genau demselben
  // Muster: buildPath() würde die Platzhalter-Klammern selbst URL-kodieren.
  search.setAttribute('href', '#/u/{fp}');
  container.append(heading, hint, search);
  // Kein Rückgabewert nötig — <qu-people-search> räumt seine eigenen
  // .on()-Subscriptions in disconnectedCallback() auf, sobald die Shell
  // beim nächsten Routenwechsel `screen.textContent = ''` setzt (siehe
  // src/ui/people-search-components.js).
}
