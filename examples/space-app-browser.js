// Browser-seitiger Gegenpart zu space-app-lib.mjs — derselbe Schnitt wie
// ui/bindings.js (DOM-frei) vs. ui/components.js (browser-only) und
// cms-lib.mjs vs. cms-router.js: space-app-lib.mjs kennt kein `window`,
// dieses Modul schon (Identity-Persistenz, Relay-URL, Hash-Navigation).
//
// Deckt genau den Boilerplate ab, der sich vor dieser Datei in JEDEM
// Demo-`app.mjs` (cms, forum, ein zukünftiges todo) identisch wiederholt
// hätte: Identität laden/anlegen, Relay-URL fürs aktuelle Deployment
// bestimmen, den Hash live in `{ spaceId, path }` übersetzen.

import { Qu, LocalStorageAdapter } from '../src/index.js';
import { parseHashRoute, buildHashRoute } from './space-app-lib.mjs';

// Empty namespace: LocalStorageAdapter would otherwise prefix every key
// with `qu:` (its own default) — this app-space layer predates the
// adapter and its callers already choose full, self-contained key names
// (`storageKey` below, examples/chat's various *_KEY constants, …), so an
// empty namespace here keeps every existing localStorage key exactly as
// it already is instead of silently orphaning already-stored data (a
// user's saved identity/rooms/contacts) under a renamed key the first
// time this runs.
const storage = new LocalStorageAdapter({ namespace: '' });

/**
 * Identität aus `localStorage` laden, oder beim allerersten Aufruf neu
 * erzeugen und dort ablegen — `storageKey` ist bewusst ein Pflicht-
 * parameter (kein globaler Default), damit zwei Demos auf derselben
 * Origin (z. B. `/examples/cms/` und `/examples/forum/`) nicht versehentlich
 * dieselbe Identität teilen, nur weil beide vergessen haben, einen
 * eigenen Key zu wählen.
 *
 * Goes through Qu's own StorageAdapter (LocalStorageAdapter) instead of
 * calling `localStorage` directly — this is the one place identity has to
 * exist BEFORE any Qu instance does (you need it to create the instance
 * in the first place), which is exactly why LocalStorageAdapter is built
 * to work standalone: it has no dependency on a Runtime/QuStore, just a
 * plain namespaced get/put over Web Storage, usable at any point —
 * including this one, the earliest possible.
 */
export async function loadOrCreateIdentity(storageKey) {
  const saved = await storage.get(storageKey);
  if (saved) return Qu.create({ identity: saved });
  const qu = await Qu.create();
  await storage.put(storageKey, await qu.exportKeys());
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
