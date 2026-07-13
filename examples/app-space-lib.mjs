// Beispiel 5: eine vernetzte App über einen echten QU-Relay (WebSocket) —
// das "App-Space"-Muster: ein einziger, allen Instanzen der App bekannter
// Space, über den Daten ausgetauscht werden. Kein neues Konzept, derselbe
// Space wie überall sonst (Whitepaper §8) — nur zwei konkrete Varianten,
// wie eine App ihn benennt:
//
//   - offen (diese Datei, openAppSpace()): ein fest verabredeter Name
//     (z. B. der App-Name selbst), OHNE eigenes Manifest — die
//     Bootstrap-Regel des Spaces-Plugins ("kein Manifest = jeder darf
//     schreiben", modules/spaces.js) macht daraus einen für jeden mit
//     createSpacesPlugin() offen mitschreibbaren, geteilten Space. Genau
//     das nutzt auch dieses Repos eigener Demo-Relay (`index.js`s
//     `qu-demo-room/`-Topic). Passend für eine öffentliche Instanz/Demo,
//     nicht für echte Zugriffskontrolle.
//   - mitgliederbeschränkt (siehe restrictedAppSpace()): `qu.createSpace({
//     writers, readers })` — die entstehende UUID wird z. B. über einen
//     Link verteilt. Dasselbe Muster wie examples/todo-lib.mjs, nur jetzt
//     zusätzlich über einen Relay gespiegelt statt rein lokal.
//
// Netzwerk kommt in beiden Fällen "on top": dieselben put/set/on/map-
// Aufrufe wie überall sonst in QU, nur läuft die Verbindung über einen
// echten Relay-Prozess statt nur innerhalb eines Prozesses/Tabs.

import { createWebSocketChannel } from '../src/network/transports/websocket-browser.js';

/**
 * Verbindet eine bereits mit `createNetworkPlugin()` ausgestattete
 * Qu-Instanz per echtem WebSocket mit einem QU-Relay. `pushTopics` sind
 * die Präfixe, für die neu geschriebene QuBits sofort live weitergeleitet
 * werden (README, Abschnitt 3 "Sync, Mirror, Relay") — i. d. R. genau der
 * App-Space, den diese Instanz nutzt. Liefert `repl` zurück, damit der
 * Aufrufer selbst entscheidet, ob/wann `repl.sync({ topic, since })`
 * nötig ist (bereits vorhandene Einträge nachladen) — Verbinden und
 * Nachladen sind bewusst zwei getrennte Schritte, kein verstecktes
 * Sync-on-connect.
 */
export async function connectToRelay(qu, relayUrl, { pushTopics = [] } = {}) {
  const channel = createWebSocketChannel(relayUrl);
  await channel.connect();
  const repl = await qu.connect(channel, { pushTopics });
  return { channel, repl };
}

/**
 * Der offene App-Space: ein fest verabredeter Name, kein eigenes
 * Manifest. Braucht `createSpacesPlugin()` bereits installiert — sonst
 * verweigert schon der Core-Default (core/identity-acl.js) jeden
 * Schreibversuch auf einen generischen, nicht-eigenen Space.
 */
export function openAppSpace(qu, appSpaceId) {
  return qu.get(appSpaceId);
}

/**
 * Der mitgliederbeschränkte App-Space: **synchron** (wie jedes
 * `qu.createSpace()`, siehe core/space-handle.js), liefert sofort einen
 * Node zurück. `space.ready` abwarten, bevor die Id an andere
 * Mitglieder weitergegeben wird.
 */
export function restrictedAppSpace(qu, memberFingerprints) {
  return qu.createSpace({ writers: memberFingerprints, readers: ['*'] });
}

/** Ein neuer Eintrag — set(), weil mehrere App-Instanzen unabhängig voneinander schreiben (kollisionssicher, siehe §7.2). */
export async function postEntry(appSpace, text) {
  return appSpace.get('entries').set({ text });
}

/** Alle Einträge, älteste zuerst — einmalige Anfrage (siehe README Abschnitt 7 für Zeit-Sharding, sobald die Liste unbegrenzt wächst). */
export async function listEntries(appSpace) {
  const rows = await appSpace.session.query(`${appSpace.id}/entries/**`);
  return rows.sort((a, b) => a.ts - b.ts);
}

/** Live-Abonnement auf neue Einträge — liefert erst, was bereits existiert, danach laufend Neues (map()s Default). */
export function onEntry(appSpace, callback) {
  return appSpace.get('entries').map(callback, { deep: true });
}
