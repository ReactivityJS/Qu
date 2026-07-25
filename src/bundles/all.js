// Bundle 6/6 — everything: Core, every optional plugin group, the
// App-Space toolkit, and UI (Custom Elements included, side effect on
// import — see ui.js's own doc). Equivalent to importing src/index.js
// AND src/ui/components.js AND src/ui/profile-components.js AND
// src/ui/people-search-components.js together — the single "just give me
// the whole framework" bundle, for a consumer who isn't optimizing bundle
// size at all. BROWSER-ONLY because ui.js is (see there).
export * from './core-plugins.js';
export * from './app-space.js';
export * from './ui.js';
