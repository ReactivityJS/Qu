# QU — qu-core

Ein kleines, ereignisgetriebenes, Zero-Trust-Framework für lokale und
verteilte Anwendungen. Reines Vanilla JavaScript (ESM), keine
Laufzeit-Abhängigkeiten, läuft in Node ≥ 20 und modernen Browsern
(Web Crypto API, `crypto.randomUUID()`).

Die vollständige Architektur-Spezifikation steht in
[`qu-whitepaper-v0.6.md`](./qu-whitepaper-v0.6.md), die vollständige
Aufrufreferenz jeder Funktion/Klasse in [`API.md`](./API.md) — dieses README
ist der Schnelleinstieg.

## Installation

Kein Build-Schritt. Einfach importieren:

```js
import { Qu } from './src/index.js';
```

## Quickstart

```js
const alice = await Qu.create();
await alice.publish(`${alice.userSpaceId}/chat/room1/msg1`, { text: 'hello' });
alice.on(`${alice.userSpaceId}/chat/room1/**`, (qubit) => console.log(qubit.value));
```

Ohne jedes Plugin ist nur dein eigener `~<fingerprint>`-Space beschreibbar
(`core/identity-acl.js`) — für geteilte, generische Spaces (Chat-Räume,
ToDo-Listen, …) `qu.use(createSpacesPlugin())`.

`Qu` ist die empfohlene Fassade — sie erzeugt (oder importiert) eine
Identität und verdrahtet Runtime/Store/Session im Hintergrund,
sodass man für den Normalfall keine mehreren Bausteine von Hand
zusammensetzen muss. **Der Core selbst ist local-only/offline**: ohne
weiteres Zutun landet alles im `MemoryAdapter`, es wird kein Netzwerk-Code
geladen. Netzwerk (Replication/Transporte/Routing), Storage jenseits von
Memory/Null, und Referenz-/Datei-Handling sind Plugins — angedockt über
`qu.use(...)`:

```js
import { Qu, createNetworkPlugin, createFileHandlerPlugin, MemoryFileStorageAdapter } from './src/index.js';

const alice = await Qu.create();
alice.use(createNetworkPlugin());                                    // qu.connect()/qu.router/qu.webrtc()
alice.use(createFileHandlerPlugin({ fileStorage: new MemoryFileStorageAdapter() })); // qu.shareFile()/qu.resolveFileRef()
```

Jedes Plugin ist auch ohne `use()` direkt nutzbar — `sendMessage(qu, spaceId, opts)`
aus `modules/chat.js` etwa funktioniert unverändert ohne dass irgendetwas
"installiert" wurde; `use()` fügt nur `qu.sendMessage(spaceId, opts)`-Sugar
hinzu, für wer sie will. Siehe [Core, Storage, Network, Data](#core-storage-network-data--wie-die-plugins-zusammenspielen) unten.

**Nächster Schritt: `examples/`** — drei kurze, fokussierte Beispiele
(lokaler User, zwei verbundene Clients, teilbare ToDo-Liste), deutlich
kompakter als die volle Chat-Demo. Für Multi-User-Rechte, Verschlüsselung,
Sync und Dateien: siehe [`API.md`](./API.md) (vollständige Referenz) und
`demo/` (durchgängiges
Beispiel). Die darunterliegenden Bausteine (`QuRuntime`, `QuSession`,
`QuStore`, …) bleiben für fortgeschrittene Fälle direkt nutzbar —
`qu.runtime` ist die Fluchttür dorthin.

## Grundkonzepte an Beispielen

Baut die Kernkonzepte in der Reihenfolge auf, in der man sie beim Einsatz von
QU tatsächlich braucht — von der Identität bis zum Gesamtbild "QuStore als
geteilte, entfernte Datenbank". Jeder Code-Block ist copy-paste-lauffähig
(Node-Konsole oder Browser-Konsole nach dem Laden von `src/index.js`).

### 1. Identität

Eine Identität ist ein ECDSA/ECDH-Schlüsselpaar; der `fingerprint`
(`hash(publicSigningKey)`) ist zugleich die Adresse deines eigenen Spaces
(`~<fingerprint>`) — Identität und Adressierung sind dieselbe Sache, kein
zwei getrennte Konzepte.

```js
import { Qu } from './src/index.js';

const alice = await Qu.create();                    // neues Schlüsselpaar
console.log(alice.fingerprint, alice.userSpaceId);   // z.B. "3e19cdff…", "~3e19cdff…"

const keys = await alice.exportKeys();               // { signPub, signPriv, encPub, encPriv } — z.B. in localStorage speichern
const aliceAgain = await Qu.create({ identity: keys }); // dieselbe Identität später wieder laden, gleicher Fingerprint

const visitor = await Qu.create({ guest: true });    // echte, aber rein lesende Identität — jede Schreib-Methode wirft sofort
```

### 2. Schreiben: der eigene Context per Default, ein anderer Context nur mit Erlaubnis

Ohne jedes Plugin gilt der strikte Core-Default (`core/identity-acl.js`):
**nur der eigene User-Space ist beschreibbar**, sonst nirgends. Keine
Konfiguration, sondern eine strukturelle Tatsache — nur du kannst je eine
gültige Signatur für `writer = <dein Fingerprint>` erzeugen.

```js
await alice.publish(`${alice.userSpaceId}/status`, 'online'); // eigener Context — geht immer
await alice.publish('irgendein/anderer/pfad', 'x');             // ein anderer Context — wirft: [ACL] Write denied
```

**`qu.own`** ist derselbe eigene Context, nur ohne `${alice.userSpaceId}/`
bei jedem Aufruf auszuschreiben — ein `QuSpace`-Handle, das jeden Pfad
relativ zu genau diesem Space auflöst (`publish`/`append`/`get`/`query`/
`on`, gleiche Signaturen, nur ohne den Präfix):

```js
await alice.own.publish('status', 'online'); // exakt dieselbe QuBit wie oben
console.log((await alice.own.get('status')).value); // 'online'
```

Um in einem **anderen** Context zu schreiben — einem geteilten Space, oder
dem Space einer anderen Person — muss dieser Context dich explizit als
`writer` listen. Das übernimmt das Spaces-Plugin. `qu.createSpace(opts)`
liefert direkt ein `QuSpace`-Handle für den neuen Space zurück (statt nur
die rohe Id) — Anlegen und erstes Schreiben laufen über dasselbe Objekt:

```js
import { createSpacesPlugin } from './src/index.js';

// Für dieses Beispiel teilen sich alice und bob einen Prozess (eine
// Runtime) — der einfachste Fall, um writers/readers zu zeigen, ohne
// gleich Netzwerk/Sync mit hereinzunehmen (das kommt in Abschnitt 3 + 5).
const bob = await Qu.create({ runtime: alice.runtime });
alice.use(createSpacesPlugin());
const room = await alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });

await room.publish('msg1', 'hallo');              // erlaubt, weil room's Manifest alice als writer listet
await bob.publish(`${room}/msg2`, 'hi zurück');   // room funktioniert auch weiterhin wie ein roher String — ${room} interpoliert zur Id
```

Einen bereits bekannten Space **laden** (statt neu anzulegen) — egal ob
dein eigener, der einer anderen Person (`~<ihr-fingerprint>`), oder ein
geteilter Raum, dessen Id z. B. über einen Link ankam:

```js
const bobsSpace = alice.space(bob.userSpaceId);        // ~<bob-fp> — liest, was bob öffentlich freigegeben hat
const sameRoomAgain = bob.space(room.id);                // dieselbe room-Id, jetzt aus bobs Sicht
```

`qu.space(id)` selbst prüft nichts — es baut nur das Handle. Jeder
tatsächliche `publish`/`get`/`query`/`on`-Aufruf darüber wird exakt so
ACL-geprüft, wie ein direkter `qu.publish(id, ...)`-Aufruf es auch wäre;
`qu.own` ist nichts als `qu.space(qu.userSpaceId)`.

`publish(id, value)` überschreibt (LWW, benanntes Register); `append(collectionId,
value)` hängt automatisch `/${fingerprint}/${ts}` an — für Sammlungen mit
mehreren unabhängigen Schreibern (Chat, Kommentare), die strukturell nie
kollidieren können:

```js
await room.append('msgs', { text: 'erste Nachricht' });  // landet unter room/msgs/<alice-fp>/<ts>
await bob.append(`${room}/msgs`, { text: 'zweite Nachricht' }); // eigener Namensraum, keine Kollision möglich
```

### 3. Sync, Mirror, Relay

Alles bisherige lief rein lokal (`MemoryAdapter`, kein Netzwerk-Code
geladen). Für geräteübergreifenden Zugriff auf denselben Space:
`createNetworkPlugin()` + ein `Channel` + `qu.connect()`.

```js
import { createNetworkPlugin, createWebSocketChannel } from './src/index.js';

alice.use(createNetworkPlugin());
const channel = createWebSocketChannel('wss://mein-relay/relay');
await channel.connect();
const repl = await alice.connect(channel, { pushTopics: [alice.userSpaceId] }); // beweist zuerst den Fingerprint (Handshake), verdrahtet danach Replication

await repl.sync({ topic: alice.userSpaceId, since: 0 }); // reziprok: die Gegenseite fragt automatisch zurück — ein Aufruf leert beide Richtungen
```

`pushTopics` sind die Präfixe, für die neu eintreffende QuBits sofort live
weitergeleitet werden. Ein **Relay** (`relay/relay.mjs`) ist dieselbe "eine
Runtime, viele Channels"-Architektur wie jede andere QU-Instanz, nur als
Server-Prozess betrieben — kennt weder Chat noch irgendeine konkrete
Anwendung. `role: 'mirror'` (statt `role: 'sync'`) an `qu.connect()`
markiert eine Verbindung als bedingungslose Storage-Kopie, die keine
Routing-Optimierung je wegoptimieren darf — typischerweise die Verbindung zu
genau diesem Relay:

```js
await alice.connect(channel, { role: 'mirror', pushTopics: [alice.userSpaceId] }); // alles, was alice schreibt, geht bedingungslos zum Relay
```

Ein Relay mit einem durablen `StorageAdapter` (z.B. Filesystem) UND
`role: 'mirror'` ergibt zusammen einen **Storage-Mirror**: eine entfernte,
dauerhafte Kopie deines Spaces, die auch dann online bleibt, wenn dein
eigenes Gerät offline ist.

### 4. Arten von Events

Diese Matrix ist eine der zentralen Kernideen von QU, nicht nur eine
Konfigurationsoption unter vielen: **jedes** `publish()`/`append()` ist ein
Event, und genau zwei unabhängige Dimensionen legen vollständig fest, was
mit ihm passiert — es gibt keine dritte, versteckte Form. Ein "Event" in QU
ist schlicht ein QuBit, das über `on()` zugestellt wird:

**Ort — lokal oder remote-shared:**
- **Lokal**: kein Network-Plugin installiert/verbunden — `publish()`/`append()` bleibt auf diesem Prozess/Tab.
- **Remote-shared**: `createNetworkPlugin()` + `qu.connect()` — derselbe `publish()`/`on()`-Code, jetzt zusätzlich über `pushTopics` an verbundene Peers weitergereicht (Abschnitt 3).

**Dauerhaftigkeit — vier Stufen, alle über denselben `StorageAdapter`-Contract austauschbar:**
| Adapter | Übersteht Reload? | Übersteht Tab-Schließen/Neustart? | Typischer Einsatz |
|---|---|---|---|
| `MemoryAdapter` (Core-Default) | ❌ | ❌ | Tests, Demos, rein session-lange Daten |
| `SessionStorageAdapter` (Browser) | ✅ | ❌ | Formular-Entwurf, der einen Reload übersteht |
| `LocalStorageAdapter` / `IndexedDBAdapter` (Browser) | ✅ | ✅ | echte Nutzdaten im Browser |
| `node-fs`-Adapter (Node, nicht im Barrel, siehe `adapters/node-fs.js`) | ✅ | ✅ | Server-/Relay-seitige Persistenz |

Ganz am flüchtigen Ende, noch vor `MemoryAdapter`, gibt es zwei bewusst
unterschiedliche Mechanismen:
- **`NullAdapter`-Mount**: ein *echtes* QuBit — signiert, ACL-geprüft, live
  gepusht und dispatcht wie jedes andere — nur die Storage-Ebene verwirft es
  sofort (`get`/`getAll` liefern immer leer). Ein später (oder nach
  `initial: true`) hinzukommender Listener sieht es nie. Für reine
  Event-Bus-Mounts (Presence, Live-Ticker), die trotzdem den vollen
  Zero-Trust-Schreibpfad durchlaufen sollen.
- **`runtime.emit(topic, payload)`**: kein QuBit überhaupt — unsigniert,
  kein ACL-Check, kein Store-Write. Für modul-interne Lifecycle-Signale
  (z.B. `sync.complete`), nicht für Nutzdaten.

Storage-Wahl ist reine Konfiguration am `QuStore`-Mount, unabhängig von allem anderen:
```js
import { Qu, QuStore, LocalStorageAdapter, SessionStorageAdapter } from './src/index.js';

const fluechtig = await Qu.create();                                                          // Memory, Default
const proSitzung = await Qu.create({ store: new QuStore([{ prefix: '', adapter: new SessionStorageAdapter() }]) });
const dauerhaft  = await Qu.create({ store: new QuStore([{ prefix: '', adapter: new LocalStorageAdapter() }]) });
```

`Qu.create({ mounts })` ist Sugar für genau das, ohne selbst ein `QuStore`
zu bauen — verschiedene Präfixe auf verschiedenen Adaptern in einem
Konfig-Objekt, die direkte Antwort auf "welcher StorageAdapter für welche
Art von Event":
```js
import { Qu, MemoryAdapter, NullAdapter, LocalStorageAdapter } from './src/index.js';

const qu = await Qu.create({
  mounts: [
    { prefix: '', adapter: new LocalStorageAdapter() },          // Standard: dauerhaft
    { prefix: '~fp/presence/', adapter: new NullAdapter() },     // reiner Event-Bus, nie persistiert
    { prefix: '~fp/draft/', adapter: new MemoryAdapter() },      // session-lang, absichtlich flüchtig
  ],
});
```
Ebenso `Qu.create({ plugins })` — Sugar für eine `use()`-Schleife direkt
nach dem Anlegen, für Apps, die Spaces/Files/Referenzen/Network immer dabei
haben wollen, ohne eine separate `use()`-Kette zu schreiben:
```js
import { Qu, createSpacesPlugin, createFileHandlerPlugin, MemoryFileStorageAdapter } from './src/index.js';

const qu = await Qu.create({
  plugins: [createSpacesPlugin(), createFileHandlerPlugin({ fileStorage: new MemoryFileStorageAdapter() })],
});
```
Beide Optionen sind rein additiv — `Qu.create()` ganz ohne sie verhält sich
exakt wie bisher, komplett lokal, keine Plugins geladen.

**Listener:** `on(pattern, callback, { initial?, once? })` — `initial: true`
liefert erst alles bereits Passende, danach laufend Neues (kein manuelles
`query()` + `on()` mehr nötig); `once: true` liefert nur den aktuellen
Stand, keine laufende Subscription.

### 5. Trigger & Listen: Events auslösen und darauf reagieren

Die Kombinationen aus Abschnitt 4 an einem durchgehenden Beispiel — derselbe
`on()`/`publish()`-Code für jede:

```js
// Lokal + Memory (Standard)
const qu = await Qu.create();
qu.on(`${qu.userSpaceId}/counter`, (q) => console.log('lokal:', q.value));
await qu.publish(`${qu.userSpaceId}/counter`, 1);

// Lokal + flüchtig (kein QuBit, kein Store, modul-intern)
qu.runtime.on('lab.progress', (e) => console.log('flüchtig:', e.step)); // payload-Felder liegen direkt auf e, nicht unter e.payload
qu.runtime.emit('lab.progress', { step: 3 });

// Remote-shared: zwei GETRENNTE Runtimes (anders als bobs geteilte Runtime
// in Abschnitt 2!), verbunden per Loopback-Channel — für einen echten
// Relay createWebSocketChannel(url) statt createLoopbackChannelPair().
// Absichtlich unter alice' EIGENEM User-Space (nicht dem "room" aus Abschnitt 2)
// — der ist auf jeder Runtime strukturell gültig, ganz ohne Spaces-Plugin
// oder eine erst noch zu synchronisierende Manifest-QuBit auf bobRemotes
// Seite (siehe Abschnitt 2: fingerprint = hash(pubKey) macht "alice darf
// unter ihrem eigenen Space schreiben" zu einer kryptographischen Tatsache,
// die jede Runtime unabhängig selbst prüfen kann).
import { createNetworkPlugin, createLoopbackChannelPair } from './src/index.js';

const bobRemote = await Qu.create(); // eigene, unabhängige Runtime — nicht bob aus Abschnitt 2
[alice, bobRemote].forEach((qu) => qu.use(createNetworkPlugin()));
const { a, b } = createLoopbackChannelPair();
await Promise.all([
  alice.connect(a, { pushTopics: [alice.userSpaceId] }),
  bobRemote.connect(b, { pushTopics: [alice.userSpaceId] }),
]);

bobRemote.on(`${alice.userSpaceId}/msg`, (q) => console.log('bei bob angekommen:', q.value)); // Listener zuerst registrieren
await alice.publish(`${alice.userSpaceId}/msg`, 'hallo bob');                                  // kommt live bei bob an, ganz ohne dass bob je gefragt hat
```

### 6. QuStore als verteilte, geteilte DB

Mit den obigen Bausteinen zusammengesetzt ergibt sich ein Bild, das über
"Event-System" hinausgeht: QU ist eine **reaktive, verteilte Datenbank**,
bei der jede klassische DB-Frage eine direkte Entsprechung hat:

| Klassische DB-Frage | QU-Antwort |
|---|---|
| Was ist eine Zeile? | Ein QuBit (`{id, value, ts, writer, sig}`) — `publish()` = LWW-Register, `append()` = kollisionsfreier Sammlungs-Eintrag |
| Wie stelle ich eine Anfrage? | `query(pattern)` — einmalig; `on(pattern, cb, {initial:true})` — dieselbe Anfrage, dauerhaft live |
| Welche Storage-Engine? | Austauschbarer `StorageAdapter` — Memory/Session/Local/IndexedDB/Filesystem, identische API (Abschnitt 4) |
| Wie repliziere ich zu einer entfernten Kopie? | `qu.connect()` + `pushTopics`/`role: 'mirror'` — derselbe Space, gespiegelt auf einen Relay-Prozess (Abschnitt 3) |
| Wie sind Rechte modelliert? | Pro Space (nicht pro Tabelle/Zeile): ein Manifest mit `writers`/`readers`/`admins`, write-seitig als Middleware erzwungen (`runtime.ingest()`), read-seitig gefiltert (`filterForReader()`) |
| Wie adressiere ich relativ statt jedes Mal den vollen Pfad? | `QuSpace` (`qu.own`, `qu.space(id)`, `qu.createSpace()`) — ein Handle, an einen Space gebunden, `publish`/`get`/`query`/`on` relativ dazu (Abschnitt 2) |
| Ordering-Garantie? | Hybrid-Logical-Clock (`runtime.nextTs()`) statt Wall-Clock — konsistente Ordering-Entscheidungen auch über mehrere Schreiber/Geräte hinweg |

Ein Client, der lokal schreibt, ein Relay mit durablem Storage, und beliebig
viele weitere Clients, die sich über `sync()`/Live-Push denselben Space
teilen, bilden zusammen genau das: eine eventually-consistent, geteilte
Datenbank, bei der "eine Query stellen" und "auf Änderungen lauschen"
dieselbe Operation sind (`on()`), nicht zwei getrennte APIs.

## Projektstruktur

```
index.js                ← Server-Bootstrap (ruft nur server/static-server.mjs auf, kein QU-Code)
index.html                ← Navigation zu Demo/Tests/Whitepaper/README/API (ebenfalls kein QU-Code)
API.md                     vollständige Aufrufreferenz (Parameter, Rückgabewerte, Beispiele)
server/static-server.mjs   generischer statischer Dateiserver
assets/style.css            gemeinsames Stylesheet für alle Tooling-Seiten
docs/view.html                generischer Markdown-Viewer (Whitepaper, README, API.md)
src/
  index.js              ← einziger öffentlicher Einstiegspunkt der Bibliothek
                          (Core + Memory/Null-Adapter + alle Plugin-Factories —
                          kein node:fs, kein Browser-only-Code zwingend geladen)
  qu.js                   Qu — schlanke Fassade: Identity/Session/publish+append+
                          get+query+on, qu.own/qu.space(id) (QuSpace-Handles),
                          generisches qu.use(plugin), qu.setACLResolver() (der
                          Erweiterungspunkt, den createSpacesPlugin() nutzt),
                          Qu.create({ mounts?, plugins? }) als Sugar für einen
                          eigenen QuStore bzw. eine use()-Kette
  core/                  lokal, offline-sicher, keine Netzwerk-/Storage-Vendor-
                          Abhängigkeit: Pipeline, Runtime, Store (Adapter-Mounts),
                          Session, Identity, Space-Handle (QuSpace — an einen
                          Space gebundenes publish/get/query/on, reine
                          Adressierung, kein Policy-Entscheid), Clock,
                          Subscription Engine (Trie), Channel-Contract,
                          StorageAdapter-Contract, Space (String-Helfer),
                          Bytes, Debug, Verify (Zero-Trust-Signaturprüfung),
                          ACL-Enforcement, **Identity-ACL** (Zero-Config-
                          Default: nur dein eigenes ~<fingerprint> ist
                          beschreibbar — siehe unten), Sign (canonical
                          payload), Crypto (ECDH+HKDF+AES-256-GCM)
  adapters/              Kategorie 1 — Storage-Adapter: Memory · Null ·
                          MemoryFileStorage (Core-Default) · LocalStorage ·
                          SessionStorage · IndexedDB (Browser) · node-fs ·
                          node-fs-file-storage (Node, node:fs — bewusst NICHT
                          im Barrel, siehe index.js)
  network/               Kategorie 2 — Replication, Transporte, Routing, alles
                          optional: Handshake, Router, Routed-Events,
                          replication/{Default,Hub,Provider}, transports/
                          {WebSocket,WebRTC}, WebRTC-Peer-Manager,
                          index.js (createNetworkPlugin — qu.connect()/qu.router/
                          qu.webrtc()-Sugar)
  data/                  Kategorie 3 — Referenzen & Dateien: references.js
                          (obj://, key://, file:// — ReferenceHandler, Tiefen-
                          limit konfigurierbar), files/{manifest,transfer}.js
                          (Chunking/Content-Addressing/Transfer-Protokoll,
                          unverändert), files/contract.js (FileStorageAdapter-
                          Contract), files/index.js (FileHandler — file://-
                          Wrapper, createFileHandlerPlugin)
  modules/                Anwendungsmodule, optional, nur auf öffentlicher
                          Runtime/Session/Qu-API aufgebaut:
    spaces.js              createSpacesPlugin() — Space-ACL-Resolver
                          (Manifest-basiert) + qu.createSpace(). Ersetzt den
                          Core-Default (core/identity-acl.js: nur dein
                          eigenes ~<fingerprint>) durch manifest-bewusste
                          Auflösung; ohne dieses Plugin existiert
                          qu.createSpace() gar nicht und kein generischer
                          Space ist beschreibbar
    chat.js                  Räume, Nachrichten, Anhänge, Presence, Lesebestätigungen
                          (auf append()+publish() aufgebaut), createChatPlugin
  ui/
    bindings.js               viewKey/viewObject (one-way) + bindKey/bindObject
                          (two-way) — die reaktiven UI-Primitive, auf denen
                          jede Lab-Ansicht aufbaut: nichts als qu.on() +
                          Render-Callback, unmount = off(). DOM-Library-
                          agnostisch (kein document.* hier drin, Callers
                          liefern die Element-Glue). Echo-Schutz beim
                          Two-Way-Binding: Schreiben unterbleibt bei
                          identischem Wert, Re-Render unterbleibt bei
                          identischem (id, ts) statt Wertevergleich — siehe
                          Doku-Kommentar in der Datei.
    components.js             <qu-view>/<qu-bind>/<qu-list> — Custom Elements
                          über bindings.js: connectedCallback()/
                          disconnectedCallback() sind das on()/off(), das
                          bindings.js-Aufrufer bisher von Hand verdrahten
                          mussten. <qu-bind> ist <qu-view> plus
                          Schreiben-zurück, eine überschriebene Methode statt
                          eines zweiten Mechanismus. `path` (+ optional
                          `key`, ergibt `${path}/${key}` als eigene
                          Leaf-QuBit — deckt ein Objekt mit mehreren
                          Properties als N Geschwister-Elemente ab, dieselbe
                          "jedes Feld seine eigene Leaf-QuBit"-Philosophie
                          wie bindObject()) und `attr` (Default wie bindKey
                          selbst: value falls vorhanden, sonst textContent;
                          frei überschreibbar auf innerHTML/checked/jedes
                          HTML-Attribut wie href/src/class). `path` selbst
                          ist weglassbar, wenn der `.qu`-Context eine `.id`
                          hat (ein QuSpace) — dann wird dessen eigene Id
                          verwendet. Bindet ein eingewickeltes einzelnes
                          Kind-Element (z.B. ein echtes `<input>`) statt
                          `is="..."` zu brauchen (fehlt in Safari).
                          `<qu-list path="...">` ist die deklarative Form
                          von viewObject() — ein `<template>`-Kind, geklont
                          pro Kind-QuBit, jeder Klon-Wurzel `.qu` auf
                          `qu.space(<Item-Id>)` gesetzt, sodass `<qu-view
                          key>`/`<qu-bind key>` im Template ihre Felder ohne
                          Id-Wiederholung adressieren; deckt nur den
                          Leaf-per-Field-Fall ab (siehe API.md). Qu-Instanz
                          nie global: `.qu` als Property auf dem Element
                          oder einem Vorfahren, per DOM-Walk gefunden — auch
                          ein QuSpace (`qu.own`/`qu.space(id)`), nicht nur
                          eine Qu-Instanz. Bewusst BROWSER-ONLY (erweitert
                          HTMLElement beim Modul-Laden), deshalb nicht im
                          Barrel `src/index.js`, direkt importieren.
test/
  qu.test.mjs               Tests für die Qu-Fassade
  space-handle.test.mjs         Tests für QuSpace (qu.own/qu.space()/createSpace()) und Qu.create({ mounts, plugins })
  chat.test.mjs               Tests für das Chat-Modul (inkl. Kollisionssicherheit, Presence, Lesebestätigungen)
  relay.test.mjs               End-to-End gegen den echten WebSocket-Relay (native WebSocket-Clients, kein Loopback)
  references.test.mjs            obj://, key://, file://, Tiefenlimit, Zyklenschutz
  *.test.mjs                node:test — je Datei ein weiterer Themenbereich
  browser-shim/             node:test/node:assert-Ersatz für den Browser
  index.html                 dieselben Tests, im Browser (via Import-Map)
docs/lab/                    interaktives Lab — der primäre Weg, QU im Browser
                            selbst auszuprobieren (siehe eigener Abschnitt unten)
  index.html                 Navigation + vier Abschnitte, je ein "Ausführen"-Button
  render.mjs                  DOM-Rendering für Schritt-Karten (Code-Block + Ergebnis)
  lab-runner.mjs                generischer Schritt-Executor
  labs/
    01-local-identity.mjs        Identität anlegen/speichern/laden, Nutzdaten löschen,
                                User löschen — echt in localStorage, kein Mock
    02-local-spaces.mjs           strikter Core-Default vs. Spaces-Plugin, zwei lokale
                                User, Schreibrecht gewähren
    03-storage.mjs                  fünf Storage-Adapter am selben Contract, inkl.
                                LocalStorage/SessionStorage/IndexedDB — echter
                                Browser-Test, nicht nur node --check
    04-network-relay.mjs             echter WebSocket-Relay, Live-Push, reziproker
                                Sync, Datei-Mirroring
    05-references-practice.mjs        obj://key://file:// an einem Beispiel;
                                mountLibraryView() zeigt beide UI-Ebenen
                                nebeneinander: viewObject() (src/ui/
                                bindings.js, JS) für die Liste — kein
                                deklaratives Gegenstück für "Kind-QuBits
                                unter einem Prefix aufzählen" — und
                                <qu-bind> (src/ui/components.js, Custom
                                Element) für ein zweiseitig gebundenes
                                Notizfeld je Eintrag (tippen schreibt
                                sofort, kein Speichern-Knopf)
examples/
  todo-lib.mjs               Logik einer teilbaren ToDo-Liste, getrennt von jeder UI
  todo-lib.test.mjs            node:test dafür — Space + Link + FP-basiertes Schreibrecht
relay/
  ws-server.mjs              minimaler RFC-6455-WebSocket-Server, keine Abhängigkeit
  relay.mjs                    createRelay() — universeller QU-Relay-Kern, kein App-/Node-Bezug
  node-ws-bridge.mjs            Node-spezifische Brücke: http.Server-Upgrades → attachChannel()
archive/                     alte UI-Demos (live-chat, browser-demo, die vier
                            examples/0X-*.mjs/.html) — ersetzt durch docs/lab/,
                            nicht länger gepflegt, nur als Referenz aufbewahrt
```

## Core, Storage, Network, Data — wie die Plugins zusammenspielen

Ein `Qu.create()` ohne jedes `use()` ist vollständig lokal: Identity, Session,
`publish`/`append`/`get`/`query`/`on`, `resolveRefs` — alles auf dem
`MemoryAdapter`, kein `node:fs`-Import, kein `WebSocket`/`RTCPeerConnection`
je referenziert. Das ist mit einem einzigen Test abgesichert
(`grep` auf `src/index.js` findet keinen Netzwerk-/Node-Import) und mit
einem End-to-End-Smoke-Test (`Qu.create()` → `publish`/`get` → funktioniert,
ganz ohne Plugin).

**Der ACL-Default ist bewusst strikt, nicht "offen bis konfiguriert":** ohne
jedes Plugin darfst du ausschließlich unter deinem eigenen
`~<fingerprint>/**` schreiben, sonst nirgends (`core/identity-acl.js`). Das
ist keine Sicherheitslücke, die später gestopft wird, sondern die einzige
ACL-Tatsache, die strukturell zur Identität selbst gehört: `fingerprint =
hash(pubKey)` (`core/identity.js`) bedeutet bereits, dass nur du je eine
gültige Signatur für `writer = <dein Fingerprint>` erzeugen kannst — "du
darfst unter deinem eigenen Space schreiben" kostet also nichts extra, kein
Manifest, kein Storage-Roundtrip. Generische (Nicht-User-)Spaces,
zusätzliche Writer auf deinem eigenen Space per Manifest, `readers`/`admins`-
Listen — das sind echte Policy-Entscheidungen, keine strukturellen, und
gehören dem Spaces-Plugin (`createSpacesPlugin()`, siehe Punkt 4 unten).
`qu.setACLResolver(getACL)` ist der Erweiterungspunkt, den das Plugin nutzt
— er tauscht aus, *welche* Policy die bereits laufende Verify+ACL-Middleware
befragt, ohne sie neu zu registrieren (die Middleware selbst ist immer aktiv,
nie optional) und wirkt für **alle** Qu-Instanzen, die sich ein Runtime
teilen, nicht nur für die aufrufende.

Alles darüber hinaus ist eine von drei Plugin-Kategorien, jede über
`qu.use(plugin)` andockbar (oder — für die zugrundeliegenden Funktionen —
ganz ohne `use()` direkt aufrufbar, siehe `modules/chat.js`):

1. **Storage-Adapter** (`src/adapters/`) — `MemoryAdapter`/`NullAdapter` sind
   der Core-Default; `LocalStorageAdapter`/`SessionStorageAdapter`/
   `IndexedDBAdapter` (Browser) und `FileSystemStorageAdapter`/
   `FileSystemFileStorageAdapter` (Node, `node:fs`) sind Drop-in-Ersatz —
   an `QuStore`-Mounts übergeben, nichts sonst ändert sich.
2. **Network** (`src/network/`, `createNetworkPlugin()`) — Replication,
   Router (Subscription/Routing über mehrere Transport-Wege wie WS-Relay
   und WebRTC), Handshake, WebSocket-/WebRTC-Transporte. `qu.use(createNetworkPlugin())`
   fügt `qu.connect()`/`qu.router`/`qu.webrtc()` hinzu — vorher existieren
   diese Methoden schlicht nicht auf der Qu-Instanz. Node Relay/Router/
   StorageMirror (`relay/`) sind Deployments *dieser* Kategorie, kein
   Sonderbau: `Router{role:'mirror'}` + ein durables `StorageAdapter` +
   `relay/relay.mjs` ergeben zusammen einen StorageMirror.
3. **Data — Referenzen & Dateien** (`src/data/`) — `obj://`/`key://`/`file://`
   als URI-Schema, additiv zum bestehenden `refs`-Array:
   - `key://<pfad>` zeigt auf **einen** QuBit-Wert (Foreign-Key-artig).
   - `obj://<pfad>` sammelt die direkten Kind-QuBits unter `<pfad>/*` zu
     einem Objekt (oder mit `asArray: true` zu einem sortierten Array) —
     **das** ist der Weg, um Listen/Arrays/Tabellen abzubilden: jede
     Zeile ist ihr eigener QuBit unter `<pfad>/<zeilenschlüssel>`.
   - `file://<manifestId>` referenziert eine Datei; mit einem
     `FileHandler` (`createFileHandlerPlugin({ fileStorage })`) löst es zu
     echten Bytes auf, sonst zum rohen Manifest.
   - `resolveReference(qu, ref, { maxDepth, asArray, fileHandler })` /
     `resolveValue(qu, value, opts)` lösen manuell auf — bewusst kein
     automatischer Read-Hook in `Session`, gleiche Philosophie wie das
     bestehende `resolveRefs()`: der Core bleibt ein dummer Store, die App
     entscheidet, wann sie einem Link folgt. `maxDepth` (Default 1)
     begrenzt, wie viele Referenz-Hops kaskadiert werden — inklusive
     Zyklenschutz (ein Ref, der auf sich selbst zurückführt, bleibt ab dem
     zweiten Auftreten im selben Pfad unaufgelöst statt zu hängen).
4. **Spaces** (`src/modules/spaces.js`, `createSpacesPlugin()`) — löst den
   Core-Default (nur `~<eigener-fingerprint>`) durch manifest-bewusste ACL-
   Auflösung ab: generische (UUID-)Spaces mit `writers`/`readers`/`admins`,
   und zusätzliche Writer auf einem User-Space per Manifest. Fügt
   `qu.createSpace(opts)` hinzu — ohne dieses Plugin existiert die Methode
   nicht, und `createChatRoom()`/jede Multi-Writer-Anwendung ist
   unbeschreibbar. `qu.createSpace(opts)` liefert ein `QuSpace`-Handle
   zurück (siehe unten), nicht nur die rohe Id. Kein Storage-/Netzwerk-Bezug,
   also weiterhin offline-sicher — aber eine echte Policy-Entscheidung, kein
   struktureller Core-Bestandteil, deshalb Plugin statt Default.

**`QuSpace`** (`src/core/space-handle.js`) ist dagegen Core, nicht Plugin —
ein reines Adressierungs-Hilfsmittel, kein Policy-Entscheid, kostet keinen
Storage-/Manifest-Zugriff, um zu *bauen*. `qu.own` (= `qu.space(qu.userSpaceId)`)
und `qu.space(id)` sind für **jede** `Qu`-Instanz da, mit oder ohne Spaces-
Plugin — nur `qu.createSpace()` (neue generische Spaces anlegen) braucht das
Plugin, weil das ein echter Manifest-Write mit Policy-Entscheidung ist.
Ein Handle prüft selbst nichts: jeder `publish`/`get`/`query`/`on`-Aufruf
darüber läuft exakt so durch die ACL wie derselbe Aufruf mit dem vollen
Pfad direkt auf `qu`. `toString()`/`toJSON()` machen ein Handle überall
einsetzbar, wo bisher ein roher SpaceId-String erwartet wurde.

`chat.js` (`src/modules/chat.js`, `createChatPlugin()`) ist die eine
lockerere, nicht-numerierte Kategorie: ein fertiger Baustein, ausschließlich
auf der öffentlichen Runtime/Session/Qu-API aufgebaut, kein Sonderzugriff
auf den Core — eher Beispielcode als Architektur. Sein Text-Pfad
(`sendMessage`/`listMessages`/…) braucht `append()`/`query()` (Core) und
`createSpace()` (Spaces-Plugin, für den geteilten Room) — aber kein
Netzwerk-Plugin: eine Chat-Room bleibt vollständig lokal nutzbar, nur ohne
Mehrgeräte-Sync. Anhänge brauchen zusätzlich einen `FileHandler`;
Mehrgeräte-Sync zusätzlich einen `NetworkPlugin` — Chat selbst bleibt davon
unwissend.

## Im Browser (Server starten)

```
npm start
```

Startet einen minimalen, statischen Node-HTTP-Server (`index.js` — enthält
selbst keine QU-Logik, ruft nur `server/static-server.mjs` und
`relay/relay.mjs` (universeller Relay-Kern) und
`relay/node-ws-bridge.mjs` (Node-Transport) auf) auf `http://localhost:8787`. Von dort aus über
`index.html` erreichbar:

- **Interaktives Lab** (`/docs/lab/index.html`) — der primäre Einstieg zum
  Selbst-Ausprobieren: vier Abschnitte (Identität, Spaces/ACL, Storage-
  Adapter, Netzwerk/Relay/Mirror), je ein "Ausführen"-Button, echte
  Objekte auf `window` für die Konsole danach (siehe eigener Abschnitt
  unten).
- **Tests** (`/test/index.html`) — dieselben `test/*.test.mjs`-Dateien wie
  `npm test`, unverändert; eine Import-Map leitet nur `node:test` und
  `node:assert/strict` auf einen kleinen Browser-Shim um
  (`test/browser-shim/`).
- **Whitepaper**, **README**, **API-Referenz** (`/docs/view.html?file=...`)
  — ein generischer Markdown-Viewer, derselbe für alle drei Dokumente.

`index.js` und `index.html` enthalten bewusst keinen QU-Code — sie
verlinken/laden/rufen nur auf, was ohnehin existiert (`src/`, `test/`,
`demo/`, `relay/`, die `.md`-Dateien).

## Der Relay ist universell, nicht Chat-spezifisch

`relay/relay.mjs` (`createRelay()`) kennt weder Chat noch irgendeine andere
Anwendung — es ist derselbe "eine Runtime, viele Channels"-Kern, den das
Whitepaper in §10/§12 für jeden Server-Knoten vorsieht, hier nur benannt.
Es macht auch keine Annahme über Persistenz: Standard ist rein
speicherbasiert (läuft identisch in Node und im Browser), eigene
`StorageAdapter`/`FileStorageAdapter`-Instanzen werden von außen
hereingereicht. Wie eine `Channel`-Verbindung zustande kommt, ist ebenso
entkoppelt — `attachChannel()` nimmt alles, was den `Channel`-Contract
erfüllt, ob echtes WebSocket, ein zukünftiger WebRTC-DataChannel, oder ein
Browser-Tab, das für andere Tabs relayt.

`relay/node-ws-bridge.mjs` ist das einzige Node-spezifische Stück
(`bridgeWebSocketServer()`) — reine Socket-Mechanik (`http.Server`-Upgrades
zu `Channel`s), kein App-Bezug. `relay/ws-server.mjs` selbst ist ein
minimaler RFC-6455-WebSocket-Server ohne Abhängigkeit.

`index.js` entscheidet als konkretes Deployment, **was** persistiert wird
(Filesystem-Adapter, `.relay-data/`) und **welche** Topics gerouted werden
(`qu-demo-room/`) — das ist Konfiguration an der richtigen Stelle, nicht im
Relay-Kern eingebaut.

**Ein echter Fund beim Testen im echten Browser:** `FileSystemStorageAdapter`/
`FileSystemFileStorageAdapter` waren versehentlich im zentralen,
browserfähigen `src/index.js` exportiert — jede Seite, die davon
importierte, zog dadurch `node:fs` mit, was der Browser nicht auflösen
kann (CORS-Fehler beim Laden). `jsdom` konnte das in meinen eigenen Tests
nicht aufdecken, weil es Node-Module anders aufzulösen versucht als ein
echter Browser. Behoben: beide Adapter sind jetzt bewusst **nicht** Teil
des universellen Barrels, sondern nur direkt aus ihren eigenen Dateien
importierbar (`src/adapters/node-fs*.js`) — ausschließlich von Node-
spezifischem Code wie `index.js` genutzt.

Client-seitig macht `createWebSocketChannel(url)`
(`src/network/transports/websocket-browser.js`) dasselbe für den Browser, was
`createLoopbackChannelPair` für Tests tut — derselbe `Channel`-Contract, nur
über ein echtes Netzwerk.

**Ein zweiter echter Fund:** Der Server parst eingehende Frames sofort, aber
`channel.onMessage()` wird erst registriert, wenn der jeweilige Consumer
(z. B. `authenticateChannel`) tatsächlich läuft — dazwischen liegt oft ein
`await` (Schlüsselerzeugung). Nachrichten, die in dieser Lücke ankommen,
gingen zunächst spurlos verloren. Behoben durch Zwischenspeichern
unzustellbarer Nachrichten bis zum ersten `onMessage()`-Aufruf — in allen
drei Channel-Implementierungen (Loopback, WS-Server, WS-Client), nicht nur
dort, wo es zuerst auffiel.

**Presence & Lesebestätigungen** (`modules/chat.js`): Online-Status ist ein
Heartbeat auf einen festen Pro-Mitglied-Slot (`${room}/presence/${fp}`,
LWW) — ein Leser gilt nur als online, wenn `lastSeen` frisch genug ist,
unabhängig vom zuletzt veröffentlichten Status (deckt auch den Fall ab, in
dem ein Tab ohne sauberes Beenden verschwindet). Lesebestätigungen
(`${room}/reads/${fp}`) funktionieren identisch — ein LWW-Register pro
Leser, kein Sonderfall.

**Datei-/Bild-/Video-Anhänge funktionieren End-to-End**, inklusive
Relay-seitigem Chunk-Caching: Der Relay hängt pro Verbindung einen eigenen
`DefaultFileTransfer` an und zieht sich die Chunks proaktiv vom Uploader,
solange der noch verbunden ist — danach kann jeder andere Client die Datei
vom Relay laden, auch wenn der Original-Uploader längst weg ist.

Ein Leichtgewichts-Nachrichtentyp (`qu.file.readiness.request/response`)
fragt nur "hast du schon alles?", ohne selbst Bytes zu übertragen — die
Chat-UI zeigt den "Laden"-Button erst an, wenn diese Prüfung ein "ja"
liefert. Vorher führte ein zu früher Klick (Empfänger lädt, bevor der Relay
fertig gespiegelt hat) zu einer korrekten, aber unnötigen Fehlermeldung;
`requestFile()` selbst wiederholt außerdem fehlgeschlagene oder
"noch nicht da"-Chunk-Anfragen mit Backoff, statt beim ersten Fehlschlag
sofort aufzugeben.

**Reconnect ohne Reload:** Mobile Browser (getestet: Android/Chrome auf
einem Pixel 10) killen eine WebSocket-Verbindung oft lautlos, sobald der
Bildschirm ausgeht oder der Tab in den Hintergrund geht — die Seite merkt
das nicht von selbst. `live-chat.mjs` reagiert jetzt auf drei Signale:
das `close`-Event des Channels, `visibilitychange` (Bildschirm/Tab wird
wieder aktiv) und `online` (Netzwerk kommt zurück) — bei jedem wird geprüft,
ob die Verbindung noch wirklich offen ist (`channel.isOpen()`, nicht nur
"haben wir sie nie geschlossen"), und bei Bedarf mit exponentiellem Backoff
neu verbunden (neuer Channel, neuer Handshake, `sync()` nur für die Differenz
seit der letzten gesehenen Nachricht — nicht den ganzen Raum erneut).

## Routing & WebRTC: direkter Weg zu einer Node, ohne den Relay zu ersetzen

`src/network/router.js` entscheidet, welche Channels ein QuBit beim Push
bekommen — pluggable, damit Routing später ausgetauscht werden kann, ohne
Replication/Files anzufassen. Zwei Rollen:

- **`role: 'mirror'`** — bekommt *immer* alles, unabhängig von jeder
  anderen Entscheidung. Dafür gedacht: die eigene Storage-Relay-Verbindung.
  Ein Client repliziert alles, was er selbst schreibt, bedingungslos zu
  seinem Mirror — das darf keine Routing-Optimierung je wegoptimieren.
- **`role: 'sync'`** — konkurriert nur innerhalb einer *explizit* gesetzten
  `group` (z. B. `peer:<fingerprint>`) nach `metric` (niedriger gewinnt,
  Gleichstand → alle Wege). Ohne Gruppe (Standard) werden alle Sync-Routen
  unabhängig voneinander genutzt — sicherer Default, keine stillschweigend
  verlorenen Daten nur weil zwei Channels zufällig dasselbe Topic bedienen.

`Qu.connect()` ist rückwärtskompatibel um `role`/`group`/`metric`
erweitert — ohne diese Parameter identisches Verhalten wie zuvor.

**WebRTC** (`src/network/transports/webrtc-browser.js`, minimal: nur
Datenkanal, Perfect-Negotiation-Muster) ist eine weitere Channel-
Implementierung, kein Ersatz für den Relay — der Relay bleibt zwingend
für Signaling (SDP/ICE-Weiterleitung nach Fingerprint, `relay/relay.mjs`)
und als Storage-Mirror. `src/network/webrtc-peer-manager.js`
orchestriert: Verbindungsaufbau über einen bestehenden Signaling-Channel,
danach **erneuter QU-Handshake über den neuen Datenkanal** (WebRTC/DTLS
verschlüsselt, beweist aber keine Identität — das übernimmt weiterhin
unser Challenge-Response), erst danach Freigabe für Replication.

`qu.webrtc(signalingChannel)` liefert einen `PeerConnectionManager`;
`.connectDirect(fingerprint, { pushTopics, group, metric })` baut eine
Direktverbindung auf. Primärer Anwendungsfall: Weg zu einer Node ohne
Relay (Ausfall oder bewusst gewünscht) — spätere Audio/Video-Erweiterung
liegt auf derselben `RTCPeerConnection` (zusätzliche Tracks), ist aber
noch nicht gebaut.

**Ehrlicher Hinweis zur Testabdeckung:** Router, die Signaling-Weiterleitung
im Relay (inkl. Schutz vor gefälschtem Absender) und die
Router-Integration in `DefaultReplication`/`Qu.connect()` sind vollständig
automatisiert getestet — alles davon steht hinter dem bestehenden
`Channel`-Contract und lässt sich mit Loopback-Channels prüfen, ganz ohne
echtes WebRTC. `webrtc-channel-browser.mjs` selbst (echte
`RTCPeerConnection`-APIs) kann in dieser Umgebung nicht automatisiert
getestet werden (kein Browser, kein WebRTC in Node ohne natives Binding) —
sorgfältig nach dem MDN-Referenzmuster gebaut, aber ein echter Test in
einem echten Browser steht noch aus.

## Debug-Ausgabe: Listener statt Build-Schritt

QU hat bewusst keinen Build-/Minify-Schritt (§2) — "im Prod-Build entfernte
Debug-Aufrufe" hätte genau das eingeführt. Stattdessen: `debug(scope, event,
data)` (`src/core/debug.js`) ist bei null Listenern ein reiner
`Set.size`-Check, praktisch kostenlos. `onDebug(fn)` registriert einen
Listener, `enableConsoleDebug({ filter? })` ist die mitgelieferte
Konsolen-Ausgabe — identisch nutzbar in Node (Relay) und Browser (Demo).

- **Relay:** standardmäßig an (`QU_DEBUG=0` zum Abschalten,
  `QU_DEBUG_SCOPE=relay,files` zum Filtern).
- **Live-Chat:** standardmäßig an, zusätzlich als sichtbares Panel auf der
  Seite selbst (nicht nur Konsole) — `?debug=0` zum Abschalten.
- Instrumentiert: `Runtime.ingest()` (accept/reject/noop),
  `DefaultReplication` (push/sync), `DefaultFileTransfer`
  (manifest/chunk-Anfragen), der Relay (Verbindungen, Spiegelung), beide
  WebSocket-Channel-Implementierungen (jede Nachricht rein/raus).

**Zwei echte Bugs dabei gefunden und behoben** (Auslöser: Bilder im Chat
ließen Nachrichten "verschwinden"):

1. **Unhandled Promise Rejection konnte den ganzen Relay-Prozess töten.**
   `DefaultReplication#handleMessage` und `DefaultFileTransfer#handleMessage`
   sind `async`, wurden aber über `Set.forEach()` aufgerufen, ohne dass
   jemand die Rejection abfängt — in Node killt das standardmäßig den
   gesamten Prozess (alle Verbindungen, nicht nur eine). Ein abgelehnter
   Push (z. B. eine fehlgeschlagene Signaturprüfung) reichte aus. Fix: ein
   gemeinsames `safeInvoke()` in allen drei Channel-Implementierungen fängt
   jetzt jeden Listener-Fehler ab, plus explizites Error-Handling direkt an
   den betroffenen Stellen.
2. **Der WebSocket-Server prüfte nie das FIN-Bit** und kannte keine
   Fortsetzungs-Frames (Opcode `0x0`) — eine fragmentierte Nachricht hätte
   nur ihr erstes, unvollständiges Fragment geparst (meist ungültiges JSON,
   still verworfen) und jedes weitere Fragment ignoriert. Behoben durch
   echte Frame-Reassemblierung; mit echten, manuell konstruierten
   mehrteiligen WS-Frames getestet, nicht nur angenommen.

## Tests (CLI)

```
npm test
```

Nutzt Node's eingebauten Test-Runner (`node --test`), keine externe
Test-Bibliothek. Jede Datei unter `test/` behandelt einen Themenbereich
(Core, Identity, Session, Spaces/ACL, Replication, Files) statt einer
einzigen großen Assertion-Liste.

## Interaktives Lab (`docs/lab/`)

```
npm start
# dann /docs/lab/index.html öffnen
```

Der primäre Weg, QU im Browser selbst auszuprobieren — ersetzt die alten
Terminal-/Einzelseiten-Demos (jetzt in `archive/`, nicht mehr gepflegt).
Fünf eigenständige Abschnitte, jeder per eigenem "Ausführen"-Button
startbar, jeder mit dem exakt gezeigten Code (keine narrative Annäherung):

1. **Identität** — anlegen, in `localStorage` speichern, wieder laden
   (simulierter Reload), Nutzdaten löschen (Identität bleibt), User löschen
   (Schlüsselpaar weg). Echter `LocalStorageAdapter`, kein Mock.
2. **Spaces & Mehrbenutzer-ACL** — der strikte Core-Default (nur der eigene
   User-Space) live scheitern sehen, dann das Spaces-Plugin: zwei lokale
   User auf einer Runtime, Schreibrecht verweigert → gewährt → erfolgreich.
3. **Storage-Adapter** — fünf austauschbare Backends am selben Contract,
   inklusive `LocalStorageAdapter`/`SessionStorageAdapter`/`IndexedDBAdapter`
   — der erste echte Browser-Test dieser drei (vorher nur `node --check`).
4. **Netzwerk** — derselbe echte WebSocket-Relay, der diese Seite
   ausliefert: Handshake, Live-Push, reziproker Sync für einen später
   verbindenden Client, Datei-Mirroring (ein Client lädt eine Datei vom
   Relay, nachdem der Original-Uploader schon getrennt hat).
5. **Referenzen in der Praxis** — eine kleine Kontakt-/Dateibibliothek:
   `obj://` baut die Liste, `key://` verweist auf eine Kategorie, `file://`
   auf einen echten Datei-Upload (`<input type="file">`, keine synthetischen
   Bytes). Liste **und** Notizfeld sind **durchgängig reaktiv** und zeigen
   bewusst beide UI-Ebenen nebeneinander, jede dort, wo sie das richtige
   Werkzeug ist, statt auf Hand-verdrahtetem `qu.on(...)`:
   `viewObject()` (`src/ui/bindings.js`, JS) für die Liste — die Einträge
   liegen als EIN kombiniertes Objekt (`{name, category, avatar,
   createdAt}`) statt als Leaf-per-Field vor und `category`/`avatar`
   müssen erst über `resolveReference()` aufgelöst werden, beides
   außerhalb dessen, was das deklarative `<qu-list>` abdeckt (siehe unten
   und API.md) — hier bleibt JS also die richtige Wahl, nicht weil es
   grundsätzlich keine deklarative Form gäbe (`initial: true` liefert beim
   Mounten zuerst, was schon da ist, danach kommt jede Änderung — neuer
   Eintrag, neuer Upload — über dieselbe Subscription herein) — und
   `<qu-bind>` (`src/ui/components.js`, Custom
   Element) für ein zweiseitig gebundenes Notizfeld je Eintrag: Tippen
   schreibt sofort in eine eigene Leaf-QuBit (`<eintragId>/note`), kein
   Speichern-Knopf, `path`+`key` statt einem manuellen `bindKey()`-Aufruf,
   und `disconnectedCallback()` räumt beim Entfernen aus dem DOM automatisch
   auf. Derselbe Echo-Schutz gilt in beiden Fällen (Vergleich über `(id,
   ts)` beim Rendern, Wert-Vergleich vor dem Schreiben) — `<qu-bind>` ruft
   intern dieselbe `bindKey()`-Funktion nur aus einem `connectedCallback()`
   statt von Hand auf. Kein Lab-Abschnitt mit einer Liste/Live-Ansicht oder
   einem editierbaren Feld sollte künftig anders gebaut werden — Snapshot-
   nach-Klick ist nur für einmalige Diagnose-Schritte richtig (siehe
   Abschnitt 5, Schritt 4, der genau diesen Kontrast explizit zeigt).

Jeder Abschnitt hängt seine zentralen Objekte an `window` (z.B. `window.qu`
nach Abschnitt 1, `window.quLab.network.alice` immer) — zum Weiterprobieren
in der echten Browser-Konsole nach dem Klick, nicht nur zum Zusehen.

`examples/todo-lib.mjs` (+ `todo-lib.test.mjs`) bleibt separat aktiv: reine
Bibliothekslogik einer teilbaren ToDo-Liste (Space + Link + FP-basiertes
Schreibrecht), ganz ohne UI, per `node --test` prüfbar.

## Kernprinzipien (Kurzfassung — Details im Whitepaper)

- **Ein Schreibpfad:** `Runtime.ingest()` — lokal signierte und remote
  empfangene QuBits durchlaufen identisch Verify + ACL, kein Sonderfall.
- **Fingerprint = hash(publicKey):** Identitäts-Spoofing ist kryptographisch
  ausgeschlossen, nicht nur unwahrscheinlich.
- **Rechte sind an Spaces gebunden**, nicht an einzelne Pfade oder
  Nachrichten — ein Manifest pro Space.
- **Zwei Schreibmodi, keine Konvention:** `publish(id, ...)` ist ein
  benanntes, veränderliches Register (LWW); `append(collectionId, ...)`
  namensraumisiert die ID automatisch nach Schreiber-Fingerprint, damit
  unabhängige Schreiber in einer geteilten Sammlung (Chat, Kommentare)
  strukturell nie kollidieren können — ohne ACL-Sonderbehandlung.
- **Core sieht nie Klartext:** Ver-/Entschlüsselung passiert ausschließlich
  in `Session`.
- **Store ist die Offline-Queue:** keine separate Outbox-Datenstruktur;
  reziproker Sync entleert beide Richtungen bei Reconnect.
- **Jedes Event ist Ort × Dauerhaftigkeit, sonst nichts:** lokal oder
  remote-shared (Network-Plugin ja/nein), gekreuzt mit flüchtig
  (`runtime.emit()`, kein QuBit) / `NullAdapter` (echtes QuBit, nie
  gespeichert) / Memory / Session / persistent (Local/IndexedDB/Filesystem)
  — dieselbe `publish()`/`on()`-API in jeder Kombination, nur der
  `StorageAdapter`-Mount und ob ein Network-Plugin verbunden ist ändern
  sich (siehe [Grundkonzepte, Abschnitt 4](#4-arten-von-events)).
- **`QuSpace` ist Adressierung, kein Policy-Entscheid:** `qu.own`/
  `qu.space(id)`/`qu.createSpace()` geben ein an einen Space gebundenes
  Handle zurück (`publish`/`get`/`query`/`on` relativ dazu) — kostet nichts,
  prüft nichts selbst, jeder Aufruf darüber läuft exakt so durch die ACL wie
  derselbe Aufruf mit vollem Pfad auf `qu`.
- **Alles Optionale ist ein Plugin:** Storage-Adapter jenseits von
  Memory/Null, Network (Replication/Transporte/Routing), Referenzen/
  Dateien, Spaces-ACL-Resolver und Chat sind austauschbar, docken über
  `qu.use(...)` an oder sind ganz ohne Fassade direkt aufrufbar, und
  benutzen ausschließlich die öffentliche `Runtime`/`Session`/`Qu`-API —
  der Core kennt keines von ihnen (siehe
  [Core, Storage, Network, Data](#core-storage-network-data--wie-die-plugins-zusammenspielen)).

## Status

127 `node:test`-Fälle (mehrere Assertions pro thematischem Test), alle grün,
CLI geprüft — inklusive echtem WebSocket-Relay (native Clients, nicht nur
Loopback) und echten, manuell konstruierten fragmentierten WS-Frames.
`LocalStorageAdapter`/`SessionStorageAdapter`/`IndexedDBAdapter` (neu,
Browser-only) sind wie `webrtc-channel-browser.mjs` nicht per CLI testbar —
kein Browser, keine `localStorage`/`indexedDB`-Globals in Node; ein echter
Test im Browser-Testlauf (`test/index.html`) steht für diese drei noch aus.
Offen: SQLite-Adapter für `StorageAdapter`/`FileStorageAdapter`
(mechanisch, kein Architekturrisiko).
