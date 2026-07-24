// Reine, DOM-freie Logik für examples/people — derselbe Schnitt wie
// examples/chat/chat-lib.mjs vs. app.mjs (space-app-lib.mjs vs.
// space-app-browser.js): alles hier ist ohne `window`/`localStorage`
// testbar, Rendering/Identität/Netzwerk liegt in app.mjs.
//
// Suche/Filterung/Sortierung des Verzeichnisses lebt nicht mehr hier —
// <qu-people-search> (src/ui/people-search-components.js) übernimmt das
// jetzt selbst, wiederverwendbar über jede App hinweg statt nur hier.

export { isValidFingerprint } from '../../src/core/identity.js';
