// Bundle 4/6 — UI: the reactive view/binding primitives (DOM-library-
// agnostic: viewKey/viewObject are one-way, bindKey/bindObject add local
// edit write-back) plus the actual Custom Elements built on top of them
// (`<qu-view>`/`<qu-bind>`/`<qu-list>`, `<qu-profile-card>`,
// `<qu-people-search>`) — importing this bundle registers all five tags
// as a side effect, exactly like importing the individual ui/*.js files
// directly does. BROWSER-ONLY: the Custom Element classes extend
// HTMLElement at module-evaluation time, which throws immediately outside
// a browser (see src/index.js's own doc for why they're excluded from the
// main barrel) — this bundle is never meant to run in Node.
export { viewKey, viewObject, bindKey, bindObject } from '../ui/bindings.js';
export { buildPath, parsePathSegments } from '../ui/hash-router.js';
export { decideRoute, createRouter } from '../ui/router.js';
export { createWindowHashSource } from '../ui/router-browser.js';
export { getTheme, setTheme, onThemeChange, applyTheme } from '../ui/theme.js';
export { canShare, shareContent } from '../ui/share.mjs';
export { findQu, QuViewElement, QuBindElement, QuListElement } from '../ui/components.js';
export { QuProfileCardElement } from '../ui/profile-components.js';
export { QuPeopleSearchElement } from '../ui/people-search-components.js';
