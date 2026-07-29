// Nutzerverzeichnis — named to disambiguate from services/app-directory
// ("App-Verzeichnis") once both exist side by side in the nav dropdown.
// Reference-Implementierung des Mount-Vertrags aus services/README.md: ein
// `mount(container, {qu}) -> stopFn`-Export, sonst nichts. Wickelt nur die
// bereits bestehende <qu-people-search>-Komponente
// (src/ui/people-search-components.js) ein, dieselbe, die die Shell selbst
// schon auf ihrer Startseite verwendet, und die services/contacts/app.mjs's
// eigene Suche (siehe dort) — als eigener, im Nav-Dropdown gelisteter,
// direkt verlinkbarer Screen statt nur dort eingebettet.
//
// Jede Zeile bekommt zusätzlich einen <qu-contact-star> (rowActions-Erweiterung
// von <qu-people-search>, siehe deren eigene Doku) — ein Kontakt lässt sich
// direkt aus der Liste heraus hinzufügen, kein Umweg über das Profil nötig
// (der bereits bestehende "Zu Kontakten hinzufügen"-Button dort bleibt als
// zweiter Weg unverändert bestehen).
//
// Kein `<name>-lib.mjs` nötig (siehe services/README.md's Vorlage) — hier
// steckt keine eigene Logik, nur Layout um bereits fertige,
// eigenständig getestete Komponenten.

import '../../src/ui/people-search-components.js'; // Seiteneffekt: registriert <qu-people-search>
import '../../src/ui/contact-components.js'; // Seiteneffekt: registriert <qu-contact-star>

export function mount(container) {
  const heading = document.createElement('h2');
  heading.textContent = '🧭 Nutzerverzeichnis';
  const hint = document.createElement('p');
  hint.className = 'qu-directory-hint';
  hint.textContent = 'Nur Identitäten, die sich selbst sichtbar gemacht haben (eigenes Profil → „Im Verzeichnis sichtbar“). ⭐ fügt jemanden direkt zu deinen Kontakten hinzu.';
  const search = document.createElement('qu-people-search');
  search.setAttribute('mode', 'browse');
  search.setAttribute('fields', 'alias,fingerprint');
  // Literales `{fp}`-Template, nicht buildPath('u', '{fp}') — siehe
  // qu-app-shell.mjs's eigener Home-Screen-Kommentar zu genau demselben
  // Muster: buildPath() würde die Platzhalter-Klammern selbst URL-kodieren.
  search.setAttribute('href', '#/u/{fp}');
  search.setAttribute('show-fp', ''); // Avatar (klein) + Alias + Fingerprint pro Zeile — zwei Identitäten mit demselben Alias bleiben unterscheidbar
  search.rowActions = (fp) => {
    const star = document.createElement('qu-contact-star');
    star.setAttribute('fp', fp);
    return star;
  };
  container.append(heading, hint, search);
  // Kein Rückgabewert nötig — <qu-people-search> räumt seine eigenen
  // .on()-Subscriptions in disconnectedCallback() auf, sobald die Shell
  // beim nächsten Routenwechsel `screen.textContent = ''` setzt (siehe
  // src/ui/people-search-components.js).
}
