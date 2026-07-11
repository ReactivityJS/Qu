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
                          get+query+on, plus generisches qu.use(plugin) und
                          qu.setACLResolver() (der Erweiterungspunkt, den
                          createSpacesPlugin() nutzt)
  core/                  lokal, offline-sicher, keine Netzwerk-/Storage-Vendor-
                          Abhängigkeit: Pipeline, Runtime, Store (Adapter-Mounts),
                          Session, Identity, Clock, Subscription Engine (Trie),
                          Channel-Contract, StorageAdapter-Contract, Space,
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
test/
  qu.test.mjs               Tests für die Qu-Fassade
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
                                mountLibraryView() ist die reaktive Live-Ansicht,
                                gebaut auf src/ui/bindings.js: viewObject() für
                                die Liste, bindKey() für ein zweiseitig
                                gebundenes Notizfeld je Eintrag (tippen
                                schreibt sofort, kein Speichern-Knopf)
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
   unbeschreibbar. Kein Storage-/Netzwerk-Bezug, also weiterhin offline-
   sicher — aber eine echte Policy-Entscheidung, kein struktureller
   Core-Bestandteil, deshalb Plugin statt Default.

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
   Bytes). Liste **und** Notizfeld sind **durchgängig reaktiv**, beide auf
   `src/ui/bindings.js` gebaut statt auf Hand-verdrahtetem `qu.on(...)`:
   `viewObject()` für die Liste (`initial: true` liefert beim Mounten
   zuerst, was schon da ist, danach kommt jede Änderung — neuer Eintrag,
   neuer Upload — über dieselbe Subscription herein) und `bindKey()` für
   ein zweiseitig gebundenes Notizfeld je Eintrag: Tippen schreibt sofort
   in eine eigene Leaf-QuBit (`<eintragId>/note`), kein Speichern-Knopf,
   und ein Echo-Schutz verhindert sowohl unnötige Schreibvorgänge bei
   identischem Wert als auch ein Selbst-Überschreiben des Cursors beim
   Tippen (Vergleich über `(id, ts)`, nicht über den Wert). Kein
   Lab-Abschnitt mit einer Liste/Live-Ansicht oder einem editierbaren Feld
   sollte künftig anders gebaut werden — Snapshot-nach-Klick ist nur für
   einmalige Diagnose-Schritte richtig (siehe Abschnitt 5, Schritt 4, der
   genau diesen Kontrast explizit zeigt).

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
- **Alles Optionale ist ein Plugin:** Storage-Adapter jenseits von
  Memory/Null, Network (Replication/Transporte/Routing), Referenzen/
  Dateien, Spaces-ACL-Resolver und Chat sind austauschbar, docken über
  `qu.use(...)` an oder sind ganz ohne Fassade direkt aufrufbar, und
  benutzen ausschließlich die öffentliche `Runtime`/`Session`/`Qu`-API —
  der Core kennt keines von ihnen (siehe
  [Core, Storage, Network, Data](#core-storage-network-data--wie-die-plugins-zusammenspielen)).

## Status

117 `node:test`-Fälle (mehrere Assertions pro thematischem Test), alle grün,
CLI geprüft — inklusive echtem WebSocket-Relay (native Clients, nicht nur
Loopback) und echten, manuell konstruierten fragmentierten WS-Frames.
`LocalStorageAdapter`/`SessionStorageAdapter`/`IndexedDBAdapter` (neu,
Browser-only) sind wie `webrtc-channel-browser.mjs` nicht per CLI testbar —
kein Browser, keine `localStorage`/`indexedDB`-Globals in Node; ein echter
Test im Browser-Testlauf (`test/index.html`) steht für diese drei noch aus.
Offen: SQLite-Adapter für `StorageAdapter`/`FileStorageAdapter`
(mechanisch, kein Architekturrisiko).
