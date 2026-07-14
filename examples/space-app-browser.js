// Browser-seitiger Gegenpart zu space-app-lib.mjs — derselbe Schnitt wie
// ui/bindings.js (DOM-frei) vs. ui/components.js (browser-only) und
// cms-lib.mjs vs. cms-router.js: space-app-lib.mjs kennt kein `window`,
// dieses Modul schon (Identity-Persistenz, Relay-URL, Hash-Navigation).
//
// Deckt genau den Boilerplate ab, der sich vor dieser Datei in JEDEM
// Demo-`app.mjs` (cms, forum, ein zukünftiges todo) identisch wiederholt
// hätte: Identität laden/anlegen, Relay-URL fürs aktuelle Deployment
// bestimmen, den Hash live in `{ spaceId, path }` übersetzen.

import { Qu } from '../src/index.js';
import { parseHashRoute, buildHashRoute } from './space-app-lib.mjs';

/**
 * Identität aus `localStorage` laden, oder beim allerersten Aufruf neu
 * erzeugen und dort ablegen — `storageKey` ist bewusst ein Pflicht-
 * parameter (kein globaler Default), damit zwei Demos auf derselben
 * Origin (z. B. `/examples/cms/` und `/examples/forum/`) nicht versehentlich
 * dieselbe Identität teilen, nur weil beide vergessen haben, einen
 * eigenen Key zu wählen.
 */
export async function loadOrCreateIdentity(storageKey) {
  const saved = localStorage.getItem(storageKey);
  if (saved) return Qu.create({ identity: JSON.parse(saved) });
  const qu = await Qu.create();
  localStorage.setItem(storageKey, JSON.stringify(await qu.exportKeys()));
  return qu;
}

/** Der Relay dieses Deployments — `ws(s)://<host>/relay`, passend zu index.js' `bridgeWebSocketServer(server, relayApi, { path: '/relay' })`. */
export function relayUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/relay`;
}

/**
 * Live-Abonnement auf `window.location.hash`, bereits in `{ spaceId, path }`
 * übersetzt (siehe space-app-lib.mjs's parseHashRoute()) — WAS eine App
 * mit `path` anfängt, ist absichtlich nicht Sache dieses Moduls (siehe
 * cms-router.js für ein Beispiel, das zusätzlich zwischen lokaler und
 * Präsentations-Navigation unterscheidet, indem es `onRoute` selbst noch
 * einmal umschichtet). `defaultSpaceId`: welcher Space geöffnet wird,
 * solange der Hash selbst keine Space-Id trägt (z. B. beim allerersten
 * Laden ohne `#...` in der URL) — optional, für eine App mit genau einer
 * festen Space. Rückgabe: eine Unsubscribe-Funktion.
 */
export function watchRoute({ defaultSpaceId = null, onRoute }) {
  function onHashChange() {
    const { spaceId, path } = parseHashRoute(location.hash);
    const id = spaceId || defaultSpaceId;
    if (!id) return;
    onRoute({ spaceId: id, path });
  }
  window.addEventListener('hashchange', onHashChange);
  onHashChange();
  return () => window.removeEventListener('hashchange', onHashChange);
}

/** Setzt den Hash auf `#<spaceId>` oder `#<spaceId>/<path>` — der normale Weg, wie ein Navigationslink eine neue Route auslöst. */
export function navigate(spaceId, path = '') {
  window.location.hash = buildHashRoute(spaceId, path);
}
