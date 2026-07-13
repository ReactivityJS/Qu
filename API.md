# QU — API-Referenz

Dieses Dokument beschreibt jede öffentliche Funktion/Klasse aus `src/index.js`
im Detail (Parameter, Rückgabewerte, Verhalten). Für die Architektur-
Begründung dahinter (warum das so entworfen ist) siehe
[`qu-whitepaper-v0.6.md`](./qu-whitepaper-v0.6.md) — dieses Dokument ist die
Aufrufreferenz, das Whitepaper ist die Spezifikation.

Alles hier ist aus `src/index.js` importierbar:
```js
import { QuRuntime, QuSession, QuIdentity, /* ... */ } from './src/index.js';
```

---

## Inhalt

1. [Qu — Facade (empfohlener Einstieg)](#qu-facade-empfohlener-einstieg)
2. [QuSpace](#quspace) — an einen Space gebundener Node (`qu.own`/`qu.get(id)`), fünf Verben: get/put/set/on/map
3. [QuRuntime](#quruntime) — der Core
4. [QuStore](#qustore) — Persistenz & Mounts
5. [QuSession](#qusession) — Identität, Verschlüsselung, Rechte (von `Qu` intern genutzt)
6. [QuIdentity](#quidentity) — Schlüssel, Signatur, Fingerprint
7. [Channel & Handshake](#channel-handshake) — Transport-Contract
8. [Space-Helfer](#space-helfer) — Adressierung
9. [Adapter](#adapter) — Storage-Contracts
10. [Plugins](#plugins) — Verify & ACL
11. [Spaces-Modul](#spaces-modul) — ACL-Resolver
12. [Replication-Modul](#replication-modul) — Sync
13. [References-Modul](#references-modul) — `obj://`/`key://`/`file://`
14. [Files-Modul](#files-modul) — Datei-Transfer
15. [Chat-Modul](#chat-modul) — Räume, Nachrichten, Anhänge
16. [UI-Bindings-Modul](#ui-bindings-modul) — viewKey/viewObject/bindKey/bindObject
17. [UI-Components-Modul](#ui-components-modul) — `<qu-view>`/`<qu-bind>`/`<qu-list>`

---

## Qu — Facade (empfohlener Einstieg)

Für die meisten Anwendungen der einzige Import, den man braucht. `Qu`
komponiert `QuRuntime` + `QuStore` + `QuSession` + den Spaces-ACL-Resolver
hinter einfachen Instanz-Methoden — kein manuelles Verdrahten mehrerer
Objekte für den Normalfall. `QuRuntime`/`QuSession`/etc. bleiben darunter
die eigentlichen Bausteine (`qu.runtime` ist die Fluchttür für
fortgeschrittene Fälle: eigene Middleware-Reihenfolge, mehrere `Qu`-Instanzen
auf einer geteilten Runtime, benutzerdefinierte Adapter).

### `Qu.create(opts?)` → `Promise<Qu>`
Der primäre Einstiegspunkt (async, weil Schlüsselerzeugung inhärent async
ist).
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `identity` | `QuIdentity \| ExportedKeys \| undefined` | — | Wiederverwenden einer Identität oder zuvor exportierter Schlüssel (`{signPub, signPriv, encPub, encPriv}`) |
| `guest` | `boolean` | `false` | Erzeugt eine echte, aber temporäre Identität — jede Schreib-Methode lehnt sofort ab, unabhängig von der Space-ACL |
| `runtime` | `QuRuntime` | neu erzeugt | Eine bestehende Runtime teilen (z. B. mehrere Nutzer auf einem Server-Prozess) |
| `store` | `QuStore` | `MemoryAdapter`-basiert | Nur relevant, wenn `runtime` nicht mitgegeben wird. Gewinnt über `mounts`, falls beides gesetzt ist |
| `mounts` | `{ prefix, adapter, replicate? }[]` | `[{ prefix: '', adapter: new MemoryAdapter() }]` | Sugar für `store: new QuStore(mounts)`, ohne selbst ein `QuStore` zu bauen — verschiedene `StorageAdapter` für verschiedene Präfixe/Event-Arten in einem Konfig-Objekt. Ignoriert, falls `store` gesetzt ist |
| `plugins` | `(Plugin)[]` | `[]` | Jeder Eintrag wird nach der Konstruktion einmal per `qu.use(plugin)` installiert, in Array-Reihenfolge — Sugar für eine `use()`-Kette |

Ohne `identity`/`guest` wird automatisch eine neue Identität erzeugt.
Verify- und ACL-Middleware werden pro `runtime`-Instanz nur einmal
registriert, auch wenn mehrere `Qu.create()`-Aufrufe dieselbe Runtime teilen.

```js
const alice = await Qu.create();                       // neue Identität, eigenes Gerät
const bob = await Qu.create({ runtime: alice.runtime }); // teilt Alice' Runtime (z. B. ein Server-Prozess)
const guest = await Qu.create({ guest: true });           // liest, schreibt nie

const configured = await Qu.create({
  mounts: [
    { prefix: '', adapter: new LocalStorageAdapter() },
    { prefix: '~fp/presence/', adapter: new NullAdapter() },
  ],
  plugins: [createSpacesPlugin(), createNetworkPlugin()],
});
```

### `new Qu({ runtime, store?, identity?, guest?, acl? })`
Niedrigerer, synchroner Konstruktor für den Fall, dass Identität/Runtime
bereits vorliegen. `Qu.create()` nutzt ihn intern; direkt aufrufbar, wenn
eine async Fabrikmethode nicht passt.

### Identität
| Zugriff | Typ | Beschreibung |
|---|---|---|
| `qu.fingerprint` | `string \| null` | — |
| `qu.identity` | `QuIdentity \| null` | — |
| `qu.isGuest` | `boolean` | — |
| `qu.userSpaceId` | `string \| null` | `"~" + fingerprint` |
| `qu.exportKeys()` | `Promise<ExportedKeys \| null>` | Für persistente Speicherung der Identität |
| `qu.publishProfile({ alias? })` | `Promise<Qu>` | Veröffentlicht `pub`/`epub`/`alias` unter `qu.own` — siehe [Profil](#profil-qupublishprofile-qureadprofilefingerprint) unten |
| `qu.readProfile(fingerprint)` | `Promise<{fingerprint,pub,epub,alias}>` | Liest ein fremdes (oder das eigene) Profil, `alias` fällt auf `fingerprint` zurück |

### Daten: `qu.get(id)` → `QuSpace`
Der einzige Daten-Einstiegspunkt — ein an `id` gebundener Node (siehe
[`QuSpace`](#quspace) für die vollständige get/put/set/on/map-Oberfläche
und die Thenable-Semantik). Baut nur den Node, keine I/O; `qu.own` ist
`qu.get(qu.userSpaceId)`. `qu.trustPeer(fp, encPubJwk)` bleibt eine
eigenständige Qu-Methode (delegiert an `QuSession`).

**`put` vs. `set` — zwei Schreibmodi, keine Konvention:**
`node.put(value)` ist ein benanntes, veränderliches Register (LWW) — der
*gleiche* `id` von zwei verschiedenen Schreibern überschreibt sich
gegenseitig (kein Sicherheitsproblem, beide Signaturen sind echt, aber ein
echter Datenverlust, falls das nicht gewollt war). `node.set(value)` ist
der andere Modus: es hängt `${fingerprint}-${ts}` als EIN Pfadsegment an
die ID an (nicht zwei Segmente `${fingerprint}/${ts}`), *bevor* es denselben
`put()`-Pfad durchläuft — zwei verschiedene Schreiber können dadurch
strukturell nie kollidieren, ohne dass die ACL davon etwas mitbekommen
müsste (sie prüft weiterhin nur `spaceIdOf(id)`, das erste Pfadsegment,
unverändert), UND ohne dass eine lesende Seite wissen müsste, ob eine
Collection mit `put()` oder `set()` geschrieben wurde — beide sind genau
eine Ebene tief, `node.map(cb)` (ohne `{ deep: true }`) findet beide gleich.
Für "viele unabhängige Beiträge zu einer gemeinsamen Sammlung"
(Chat-Nachrichten, Kommentare, Aktivitäts-Events) immer `set()`, nie
`put()` mit einer selbstgewählten, potenziell wiederverwendeten ID. Jede
Schreib-Methode wirft sofort, wenn `qu.isGuest === true`.

`node.put(bytes, opts)` erkennt `Uint8Array`/`Blob`/`File` automatisch als
Datei (Chunking+Manifest statt einem rohen Byte-Wert) — **wenn** ein
`FileHandler` konfiguriert ist (`qu.use(createFileHandlerPlugin({ fileStorage }))`,
siehe [Files-Modul](#files-modul)); ohne FileHandler wirft `put()` bei
Datei-Bytes klar, statt sie still als opaken Wert zu schreiben.

### Profil — `qu.publishProfile()` / `qu.readProfile(fingerprint)`
**Kein** `~<fp>/profile`-Objekt — drei reservierte Leaf-QuBits direkt unter
`~<fp>`, dem User-Space selbst (`core/space.js`s `RESERVED_PROFILE_PATHS`):
`pub` (Signier-Public-Key, JWK), `epub` (ECDH-Public-Key, JWK), `alias`
(Anzeigename). Alle drei sind **strukturell immer öffentlich lesbar** —
selbst wenn der Owner die `readers`-Liste des eigenen User-Space über ein
Manifest einschränkt (`modules/spaces.js`) — sonst könnte niemand mehr
herausfinden, wie man diesem Owner überhaupt etwas verschlüsselt Adressiertes
schicken soll. Geschrieben werden dürfen sie weiterhin nur vom Owner selbst
(oder einem im eigenen Manifest ausdrücklich autorisierten Mit-Schreiber) —
die reservierten Pfade lockern nur das *Lesen*, nicht das *Schreiben*.

`qu.publishProfile({ alias? })` schreibt `pub`/`epub` (und `alias`, falls
angegeben) in einem Rutsch; `qu.readProfile(fingerprint)` liest alle drei
zurück, `alias` fällt dabei auf den Fingerprint selbst zurück, falls nie
einer veröffentlicht wurde:

```js
await alice.publishProfile({ alias: 'alice' });

const seenByBob = await bob.readProfile(alice.fingerprint);
// { fingerprint, pub, epub, alias: 'alice' }
```

`publishProfile()` ist auch die praktische Voraussetzung für die
Default-Verschlüsselung von `session.publish()`/`node.put()`/`node.set()`
(siehe [`QuSession`](#qusession) unten) — ein Sender, der einen Empfänger
noch nicht per `trustPeer()` kennt, löst dessen `~<fp>/epub` automatisch
selbst auf.

### Spaces & Space-Nodes
`qu.own` → `QuSpace` — gebunden an den eigenen User-Space (`qu.get(qu.userSpaceId)`), immer verfügbar, kein Plugin nötig.
`qu.get(spaceId)` → `QuSpace` — gebunden an einen beliebigen bekannten Space (eigener, `~<fremder-fp>`, oder generische Space-Id); baut nur den Node, prüft nichts.
`qu.createSpace({ writers?, readers?, admins? })` → `QuSpace` — **synchron**
(wie `get()`), Spaces-Plugin nötig. Liefert sofort einen Node für den neuen
Space zurück, nicht nur die rohe Id — siehe [`QuSpace`](#quspace). Das
Manifest wird im Hintergrund geschrieben (`space.ready` ist dessen eigenes
Promise); ein `async createSpace()` hätte hier den Node bis zum
Manifest-Wert hindurchgereicht statt ihn zurückzugeben, weil `QuSpace`
thenable ist und jedes Promise, das mit einem Thenable auflöst, dieses
automatisch "durchreicht" (Promise-Spezifikation) — dieselbe "kein await
navigiert, await liest"-Regel wie überall sonst in dieser API.

`qu.createSpaceAt(id, { writers?, readers?, admins? })` → `QuSpace` —
identisch zu `createSpace()`, nur mit einer selbst gewählten, festen `id`
statt einer zufällig erzeugten. Für "genau EIN wohlbekannter Space pro
App" (ein App-Space, siehe [`APP-GUIDE.md`](./APP-GUIDE.md)) statt "viele
unabhängig erzeugte Räume" (wofür `createSpace()`s zufällige Id gedacht
ist, z. B. [`examples/todo-lib.mjs`](./examples/todo-lib.mjs)) — die feste
Id ist dann gleichzeitig Adressierung (`qu.get(id)`) UND
`pushTopics`/`sync({ topic })`-Präfix, ohne dass ein separates
"Topic"-Konzept nötig wäre. Derselbe First-Write-Wins-Bootstrap wie
`createSpace()` gilt unverändert (siehe `createSpaceACLResolver` oben) —
nur racet jetzt die selbst gewählte Id, nicht eine frische zufällige.

### Presets: `QU_PRESETS`
`src/presets.js` bündelt gängige `plugins`-Listen für `Qu.create({ plugins })`:
`QU_PRESETS.local` (`[]`, Core-Default), `QU_PRESETS.spaces`
(`[createSpacesPlugin()]`), `QU_PRESETS.network`
(`[createSpacesPlugin(), createNetworkPlugin()]`). Jede Eigenschaft ist ein
Getter, kein statisches Array — jeder Zugriff baut frische Plugin-Instanzen
(wichtig für `createNetworkPlugin()`, das eigenen `router`-Zustand hält;
geteilte Instanzen über mehrere `Qu.create()`-Aufrufe hinweg würden sonst
unabhängige Runtimes/Identitäten denselben Router teilen lassen). Liegt
bewusst außerhalb `core/` — importiert aus `modules/`/`network/`, was
`qu.js` selbst nie darf (Schichttrennung).

### Replication (optionales Modul, hier bequem verdrahtet)
`qu.connect(channel, { pushTopics?, role?, group?, metric?, requireDirectWriter?, rateLimiter? })` → `Promise<DefaultReplication>` —
führt zuerst `authenticateChannel()` aus, verdrahtet danach
`DefaultReplication` mit dem bewiesenen Fingerprint. Das Replication-Objekt
hat weiterhin `.sync()`/`.repair()`/`.snapshot()`/`.peerFingerprint`/`.close()`.

`role`/`group`/`metric` sind optional und rein additiv — ohne sie
identisches Verhalten wie zuvor. Mit `role: 'mirror'` oder `role: 'sync'`
wird die Verbindung zusätzlich bei `qu.router` registriert (siehe
[`Router`](#router-webrtc)) und deren Push-Entscheidung fortan davon
mitbestimmt. `qu.router` (lazy, bei erstem Zugriff erzeugt) — Details siehe
[Router & WebRTC](#router-webrtc) weiter unten. `qu.webrtc(...)` kommt NICHT
von hier, sondern von einem zweiten, separaten Plugin
(`createWebRTCPlugin()`) — siehe dort für den Grund.

`requireDirectWriter`/`rateLimiter` sind ebenfalls optional und additiv,
betreffen aber nur **eingehende** `qu.push`-Nachrichten (nicht das oben
beschriebene ausgehende Push-Routing) — siehe
[Relay-Schutz: die Ingest-Gate-Pipeline](#relay-schutz-die-ingest-gate-pipeline-requiredirectwriter-ratelimiter-ingestgate)
weiter unten.

### Router & WebRTC
`Router` (`src/network/router.js`) entscheidet, welche Channels ein QuBit
beim Push bekommen — `role: 'mirror'` immer, `role: 'sync'` nur innerhalb
einer explizit gesetzten `group` nach `metric` (niedriger gewinnt,
Gleichstand → alle). Ohne `group`: alle Sync-Routen unabhängig, sicherer
Default.
```js
router.addRoute({ channelId, channel, pushTopics, role: 'mirror' });                          // Storage-Relay, immer
router.addRoute({ channelId, channel, pushTopics, role: 'sync', group: `peer:${fp}`, metric: 10 }); // konkurriert nur mit anderen Routen derselben Gruppe
```
`DefaultReplication` bekommt den Router optional (`router`-Option am
Konstruktor bzw. via `qu.connect(channel, { role, group?, metric? })`) —
ohne Router unverändertes Verhalten.

**`qu.use(createWebRTCPlugin())`** (`network/webrtc-plugin.js`) — ein
eigenständiges, zweites Plugin, nicht Teil von `createNetworkPlugin()`:
`webrtc-peer-manager.js` zieht echtes `RTCPeerConnection`-Gewicht nach
sich (`transports/webrtc-browser.js`), das eine App, die nur mit ihrem
eigenen Relay über WebSocket spricht, nie mitbündeln sollte. Getrennt
gehalten seit einem echten Fund: `createNetworkPlugin()` importierte
`PeerConnectionManager` vorher unbedingt, wodurch **jede** `qu.connect()`-
Nutzung WebRTC-Code mitbündelte, ob gebraucht oder nicht — real gemessen
(esbuild, minifiziert) macht die Trennung **~29 % / ~11,5 KB** aus, siehe
[README-Abschnitt zur Bundle-Größe](./README.md#core-storage-network-data-wie-die-plugins-zusammenspielen).
**Braucht `createNetworkPlugin()` bereits installiert** (teilt sich dessen
`qu.router`, keinen zweiten, unabhängigen Router) — `install()` wirft sonst
einen klaren Fehler statt still einen zwecklosen zweiten Router
aufzubauen. `QU_PRESETS.networkWebRTC` bündelt beide zusammen mit Spaces
(`src/presets.js`), für Apps, denen die Größe egal ist und die einfach
alles wollen.

`PeerConnectionManager` (`qu.webrtc(signalingChannel, opts?)`) baut
WebRTC-Direktverbindungen zu einzelnen Fingerprints auf
(`.connectDirect(fp, { pushTopics, group?, metric? })`), signalisiert über
einen bestehenden Channel (typischerweise die Relay-Verbindung — der
Relay leitet `{type:'qu.route', to, event, payload}` nach Fingerprint
weiter, ohne den Inhalt zu interpretieren) und verifiziert die
Gegenseite nach Verbindungsaufbau erneut per QU-Handshake, bevor die
Verbindung für Replication freigegeben wird — WebRTC/DTLS verschlüsselt,
beweist aber keine Identität. Ausführliche Architektur-Diskussion (Rolle
des Relays als Storage-Mirror, Routing- vs. Subscription-Frage) steht im
Whitepaper.

### Relay-Schutz: die Ingest-Gate-Pipeline (`requireDirectWriter`, `rateLimiter`, `ingestGate`)
Jeder eingehende `qu.push` einer Verbindung läuft zuerst durch eine
**Ingest-Gate-Pipeline**, bevor überhaupt `runtime.ingest()` aufgerufen
wird — dieselbe Middleware-Grundform (`(ctx, next) => Promise<void>`,
`QuPipeline`, `core/pipeline.js`) wie `Runtime.ingest()`s eigene Verify-/
ACL-Pipeline, nur mit einem anderen `ctx`:
`{ qubit, peerFingerprint, channelId }` für genau diese eine Verbindung.
Eine Gate-Middleware **wirft**, um abzulehnen (dieselbe Konvention wie
`core/acl.js`s `createACLPlugin`) — `DefaultReplication` fängt das ab,
loggt via `debug()`, verwirft den Push still, ohne die Verbindung zu
schließen. Ausgehendes Push-Routing (`pushTopics`/ACL/Router) bleibt davon
komplett unberührt.

Drei Wege, Middleware in diese Pipeline zu bringen — dieselben Optionen auf
`DefaultReplication` (Konstruktor), `ReplicationHub`, `qu.connect()` und
`createRelay()`:

**1. `requireDirectWriter: true`** — Kurzform für die eingebaute
`requireDirectWriterGate()` (`network/ingest-gate.js`). Akzeptiert einen `qu.push` nur, wenn
`qubit.writer` exakt dem per Handshake bewiesenen Fingerprint DIESER
Verbindung entspricht. Erzwingt eine strikte Stern-Topologie: dieser Relay
hört einen Write ausschließlich direkt von seiner/seinem tatsächlichen
Verfasser:in, nie über eine dritte Partei weitergeleitet. Eine Signatur
macht Fälschung ohnehin unmöglich — hier geht es darum, WER einer
bestimmten Verbindung einen Write übergeben darf, nicht um Authentizität.
**Bewusst kein Core-Default:** eine legitime Mesh-/Gossip-Topologie (ein
Client, der etwas von einem WebRTC-Peer gelernt hat, an die eigene
Mirror-Verbindung zum Relay weiterreicht) braucht genau den Fall
`writer !== peerFingerprint` — das darf nicht kaputtgehen, nur weil ein
Relay diese striktere Policy für sich selbst wählt.

**2. `rateLimiter`** — Kurzform für die eingebaute `rateLimitGate()`.
Eine `createRateLimiter({ maxPerWindow?, windowMs?, maxTrackedKeys? })`-Instanz
(`network/rate-limiter.js`, gleitendes Zeitfenster pro Schlüssel, Default
100 Writes/Sekunde) oder jedes kompatible `{ allow(key) => boolean }`.
Schlüssel ist `qubit.writer` (Fallback: `peerFingerprint`, dann die
Channel-Id) — ein flutender Peer verbraucht nie das Budget eines anderen.
Speicher bleibt begrenzt (`maxTrackedKeys`, Default 1000 — ältester Eintrag
weicht, dieselbe Technik wie `DefaultReplication`s eigener
Echo-Vermeidungs-Cache).

```js
import { createRateLimiter } from './src/index.js';

const limiter = createRateLimiter({ maxPerWindow: 100, windowMs: 1000 });
await qu.connect(channel, { requireDirectWriter: true, rateLimiter: limiter });
```

**3. `ingestGate: [(ctx, next) => ...]`** — eigene Middleware, **ohne** dass
`DefaultReplication` (oder irgendeine andere Datei) dafür geändert werden
muss. Läuft nach den beiden eingebauten Gates (falls aktiv), in
Array-Reihenfolge; `ctx.qubit`/`ctx.peerFingerprint`/`ctx.channelId` stehen
zur Verfügung, `next()` lässt durch, ein Wurf lehnt ab. Genau das war der
Punkt der Umstellung von zwei hart codierten `if`-Prüfungen auf eine
Pipeline: eine dritte/vierte Schutzregel ist eine weitere Funktion in
diesem Array, kein neuer Konstruktor-Parameter und kein neuer Sonderfall in
`#handleMessage()`.

```js
const blockOversizedPayloads = async (ctx, next) => {
  if (JSON.stringify(ctx.qubit.value).length > 10_000) {
    throw new Error(`payload too large from ${ctx.qubit.writer}`);
  }
  return next();
};

await qu.connect(channel, { requireDirectWriter: true, ingestGate: [blockOversizedPayloads] });
```

Die beiden eingebauten Gates sind auch direkt importierbar
(`requireDirectWriterGate()`, `rateLimitGate(limiter)`, beide aus
`network/ingest-gate.js`) — für volle Kontrolle über die Reihenfolge, ganz
ohne die `requireDirectWriter`/`rateLimiter`-Kurzformen:

```js
import { requireDirectWriterGate, rateLimitGate, createRateLimiter } from './src/index.js';

await qu.connect(channel, {
  ingestGate: [rateLimitGate(createRateLimiter({ maxPerWindow: 50 })), requireDirectWriterGate()],
});
```

`createRelay({ requireDirectWriter?, rateLimiter?, ingestGate? })`
(`relay/relay.mjs`) reicht alle drei identisch an jede über
`attachChannel()` angehängte Verbindung durch. Das Demo-Deployment
(`index.js`) hat `rateLimiter`
**standardmäßig aktiv** (200/Sekunde, `QU_RATE_LIMIT_MAX`/
`QU_RATE_LIMIT_WINDOW_MS` einstellbar, `QU_RATE_LIMIT=0` schaltet komplett
ab) — anders als z. B. `QU_ENABLE_TEST_ENDPOINT` (aus per Default, weil der
Endpunkt selbst erst eine echte Aktion auslöst) ist hier das UNgeschützte
`ingest()` das eigentliche Risiko, also ist "an" der sichere Standard.
`requireDirectWriter` bleibt aus (`QU_REQUIRE_DIRECT_WRITER=1` zum
Aktivieren) — eine Topologie-Entscheidung, die ein Deployment bewusst
treffen muss, keine, die man sich versehentlich einfängt.

### Files (optionales Modul, hier bequem verdrahtet)
`qu.shareFile(id, bytes, opts)` → wie [`publishFile()`](#files-modul), Session
bereits gebunden. `qu.resolveFileRef(ref, opts?)` → löst `file://<manifestId>`
zu echten Bytes auf. `qu.fileTransfer(channel, fileStorage?)` →
`DefaultFileTransfer`, Runtime bereits gebunden. Installiert außerdem einen
`setPutHandler()`-Upgrade, sodass jedes `node.put(bytes, opts)`
Datei-Bytes automatisch erkennt (siehe [Daten](#qu-facade-empfohlener-einstieg) oben).

### Chat (optionales Modul, hier bequem verdrahtet)
`qu.createChatRoom(memberFingerprints, opts?)` · `qu.sendMessage(spaceId, { text, attachments?, encryptFor? })` ·
`qu.listMessages(spaceId)` · `qu.onMessage(spaceId, cb)` — siehe
[Chat-Modul](#chat-modul) für Details.

```js
const alice = await Qu.create();
const bob = await Qu.create();
const { a, b } = createLoopbackChannelPair();

const [replAlice, replBob] = await Promise.all([alice.connect(a), bob.connect(b)]);
await alice.get('chat/room1/msg1').put('hallo');
await replBob.sync({ topic: 'chat/room1', since: 0 });
```

---

## QuSpace

Ein dünner, zustandsloser Node, gebunden an einen Space
(`src/core/space-handle.js`) — GunDB-inspiriert (`gun.get(key).put(x)`/
`.on(cb)`/`.map(cb)`), an QUs signiertes, ACL-geprüftes Schreibmodell
angepasst. Kein neuer Identitäts-/Session-Mechanismus — es wrappt dieselbe
`QuSession`, die eine `Qu`-Instanz ohnehin schon hat, also werden Writes
exakt so signiert/ACL-geprüft, als hättest du die entsprechende
`Session`-Methode mit dem vollen Pfad selbst aufgerufen. Ein Node prüft
nichts beim Bauen (`get()` — synchron, keine I/O) — nur die tatsächlichen
Aufrufe darüber (`put`/`set`/`on`/`map`/`await`).

**Fünf Verben, ein Objekt-Typ:**
| Verb | Signatur | Beschreibung |
|---|---|---|
| `get` | `node.get(subpath)` → `QuSpace` | Navigiert — Node gebunden an `${node.id}/${subpath}`. Synchron, keine I/O, LÖST NIE eine Referenz auf (auch nicht mid-path) — siehe References-Modul. Weggelassenes/leeres `subpath` liefert `node` selbst zurück. |
| `put` | `node.put(value, opts?)` → `Promise` | Schreibt AN diesem Node (LWW-Register) — EIN benannter, veränderlicher Wert; `await node` liest ihn, ein zweiter `put()` überschreibt ihn. Löst `node.id` zuerst durch eine `key://`-Kette auf (mit installiertem ReferenceHandler, Default AN — `{ raw: true }` schaltet ab), DANN erkennt es Datei-Bytes automatisch, wenn ein `FileHandler` konfiguriert ist (siehe `putDispatch` unten). |
| `set` | `node.set(value, opts?)` → `Promise` | Kollisionssicher, ARRAY-artig: der Node selbst wird nie beschrieben (`await node` bleibt `null`), jeder Aufruf legt stattdessen ein neues Kind an (`${fingerprint}-${ts}` als EIN Pfadsegment) — für Sammlungen mit mehreren unabhängigen Schreibern. Genauso eine Ebene tief wie eine `put()`-Sammlung; die Liste selbst liest man über `node.map()`/`query()`, nie über den Node direkt. Löst `node.id` wie `put()` zuerst auf (`{ raw: true }` schaltet ab). |
| `on` | `node.on(cb, opts?)` → `() => void` | Live-Subscription auf DIESEN Node — `{ initial?, once? }`, gleiche Semantik wie `QuSession.on()`. Löst `node.id` einmalig beim Aktivieren auf (nicht pro Event) — `{ raw: true }` für das alte, rein synchrone Verhalten ohne Auflösung. |
| `map` | `node.map(cb, opts?)` → `() => void` | Live-Subscription auf die KINDER dieses Nodes — `${id}/*` (findet `set()`-Sammlungen bereits ohne `deep`, s. o.); `opts.deep: true` → `${id}/**`, nur für eine Hierarchie, die eine App selbst tiefer gebaut hat. Default `{ initial: true }` (anders als `on()`). Löst `node.id` wie `on()` einmalig beim Aktivieren auf (`{ raw: true }` schaltet ab). |

**Thenable:** `await node` (bzw. `node.then()`) liest den aktuellen Wert AN
diesem Node (delegiert an `session.get(node.id)`). Navigieren (`get()`) und
Lesen (`await`) sind bewusst orthogonal: `qu.get(id)` macht selbst nie I/O;
erst `await qu.get(id)` macht genau die I/O, die das alte `qu.get(id)`
früher gemacht hat. Wichtige Konsequenz: eine `async function`, die einen
`QuSpace` `return`ed, gibt NICHT den Node zurück, wenn man sie awaitet —
die Promise-Spezifikation "chased" jeden Thenable, den ein Promise als
Auflösungswert bekommt, automatisch bis zum Ende durch (siehe `createSpace()`
unten, das deshalb bewusst synchron ist, nicht `async`).

Vier Wege, einen Node zu bekommen (siehe [Qu — Facade](#qu-facade-empfohlener-einstieg)):
- `qu.own` — gebunden an den eigenen User-Space, immer verfügbar.
- `qu.get(spaceId)` — gebunden an jeden bekannten Space (eigener, `~<fremder-fp>`, generisch).
- `qu.createSpace(opts)` — legt einen neuen generischen Space mit zufälliger Id an (Spaces-Plugin nötig), **synchron**, gibt sofort einen Node dafür zurück.
- `qu.createSpaceAt(id, opts)` — dasselbe, aber mit einer selbst gewählten festen Id statt einer zufälligen — der App-Space-Fall.

### `new QuSpace(session, spaceId, { guest?, putDispatch?, resolveDispatch? })`
Niedrigerer Konstruktor — `qu.own`/`qu.get()` nutzen ihn intern, direkt
aufrufbar für eine `QuSession` ganz ohne `Qu`-Fassade. `putDispatch(session,
id, value, opts)` (optional) ersetzt das Standard-`put()`-Verhalten (Default:
`session.publish(id, value, opts)`) — der Mechanismus, über den
`createFileHandlerPlugin()`/`qu.setPutHandler()` Datei-Auto-Detect
nachrüsten, ohne dass diese Klasse Files/Plugins kennen muss.
`resolveDispatch(session, id) => Promise<string>` (optional) ersetzt die
Standard-Identitätsfunktion `async (s, id) => id` — der gleiche Mechanismus
für `key://`-Auflösung, den `createReferenceHandlerPlugin()`/
`qu.setResolveHandler()` nachrüsten (siehe [References-Modul](#references-modul)
und [README Abschnitt 8](./README.md#8-referenzen-automatisch-folgen-key)).

### `space.id` → `string`
Die rohe Space-Id.

### `space.toString()` / `space.toJSON()`
Beide liefern `space.id` — ein `QuSpace` ist damit überall einsetzbar, wo
bisher ein roher SpaceId-String erwartet wurde: `` `${space}/msg` `` (Template-
Literal-Interpolation), `JSON.stringify({ space })` (auch verschachtelt),
und sogar direkt als `id`-Argument an `qu.session.publish(space, ...)`
— `QuSession`s öffentliche Methoden coercen jedes `id`/`pattern`-Argument
mit `String(...)`, bevor sie es verwenden.

### `space.runtime` / `space.session`
Fluchttüren, wie bei `Qu` — `.runtime` z. B. für `ui/bindings.js`s
`bindKey()` (braucht `runtime.nextTs()` für den Echo-Schutz), `.session`
für einmalige Array-Abfragen (`space.session.query(pattern)`), die
`map()`/`on()`s Callback-Form nicht direkt abdeckt.

```js
const alice = await Qu.create();
await alice.own.get('status').put('online');           // == alice.get(`${alice.userSpaceId}/status`).put('online')

alice.use(createSpacesPlugin());
const room = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] }); // synchron
await room.ready; // auf das (im Hintergrund geschriebene) Manifest warten
await room.get('msg1').put('hallo');                    // == alice.get(`${room.id}/msg1`).put('hallo')

const bob = await Qu.create({ runtime: alice.runtime });
const sameRoom = bob.get(room.id);                      // dieselbe Space-Id, unabhängig rekonstruiert (z. B. aus einem Link)
```

---

## QuRuntime

Der Core: Public API + Commit-Pipeline + Store + Dispatch. Kennt keine
Identität, keine Verschlüsselung — nur Verify/ACL-Middleware und Rohdaten.

### `new QuRuntime({ store })`
| Parameter | Typ | Beschreibung |
|---|---|---|
| `store` | `QuStore` | Persistenzschicht (siehe unten) |

### `runtime.use(middleware)`
Registriert Commit-Pipeline-Middleware (Verify, ACL, eigene Schema-Checks).
Reihenfolge = Ausführungsreihenfolge. Gibt `this` zurück (verkettbar).
```ts
type Middleware = (ctx: { qubit: QuBit; requireSignature: boolean }, next: () => Promise<void>) => Promise<void>;
```

### `runtime.ingest(qubit)`
Der **einzige** Schreibpfad. `qubit` kann bereits `sig`/`writer`/`pubKey`
tragen (typisch: von einer `Session` signiert oder von einem Peer per
Replication empfangen) oder nicht (dann greift, falls registriert, die
Verify-Middleware entsprechend `requireSignature`).
Läuft immer durch: Pipeline (Verify/ACL) → `store.put()` → Dispatch, falls
neu akzeptiert.
**Rückgabe:** `Promise<{ accepted: boolean, noop?: boolean, qubit: QuBit }>`
Wirft bei Verify-/ACL-Ablehnung.

### `runtime.publish(id, value, opts?)`
Komfort-Methode für unsignierte, lokale Writes ohne `Session`. Baut ein
QuBit (`{ id, value, ts }`) und ruft `ingest()` auf.
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `id` | `string` | — | QuBit-ID (`<SpaceId>/<Pfad>` oder `<SpaceId>`) |
| `value` | `unknown` | — | Nutzdaten |
| `opts.ts` | `number` | `runtime.nextTs()` | expliziter Zeitstempel |

### `runtime.get(id)` → `Promise<QuBit | null>`
Direkter Store-Zugriff, keine Ver-/Entschlüsselung, keine ACL-Filterung
(dafür `Session`, siehe unten).

### `runtime.query(pattern)` → `Promise<QuBit[]>`
`pattern` wie bei `on()` (`*` = ein Segment, `**` = Rest). Beispiel:
`'chat/room1/**'`. Wirft für ein ungültiges Pattern — siehe
`assertValidPattern()` unten.

### `assertValidPattern(pattern)` (`core/pattern.js`)
Wirft, falls `**` irgendwo außer als letztes Segment vorkommt (z. B.
`'posts/**/01'`) — MQTT-Konvention, hier für BEIDE Matcher gemeinsam
durchgesetzt: den Regex hinter `query()` und den Trie hinter `on()`/`map()`.
Vor dieser Prüfung "funktionierte" ein mittiges `**` nur bei `query()`
korrekt (Regex matcht den literalen Rest) — beim Trie brach die Traversierung
beim ersten `**` ab, sodass alles danach im Pattern ignoriert wurde und die
Live-Subscription faktisch zu `prefix/**` wurde (alles, nicht nur der
gemeinte Ausschnitt). `*` (ein einzelnes Segment) ist dagegen überall,
auch mittig, ohne Einschränkung gültig (`'posts/*/07/*'` — jeder Juli,
jedes Jahr). Wird automatisch von `query()` und `on()`/`map()` aufgerufen;
direkt nutzbar, um ein von außen kommendes Pattern vorab zu prüfen. Siehe
README, [Abschnitt 7](./README.md#7-datenstruktur-für-wachsende-collections-z-b-ein-forum)
für die volle Datenstruktur-Empfehlung (Zeit-Sharding für wachsende
Collections).

### `runtime.on(pattern, callback, opts?)` → `() => void`
Registriert eine Subscription im Trie. `callback(qubit)` wird bei jedem
neu akzeptierten, passenden QuBit aufgerufen. Rückgabewert ist eine
Unsubscribe-Funktion.

`opts` ist optional und rein additiv — ohne `opts` verhält sich `on()`
exakt wie zuvor (nur zukünftige Änderungen, nichts bereits Gespeichertes).
Mit `opts` lässt sich das verbreitete "erst alles Vorhandene, dann nur
Änderungen"-Muster direkt ausdrücken, statt es bei jedem Aufrufer per Hand
zusammenzusetzen (leicht subtil falsch zu machen — ein QuBit, das genau in
der Lücke zwischen manuellem `query()` und `on()` eintrifft, wurde sonst
entweder doppelt oder gar nicht zugestellt):

- **`{ initial: true }`** — liefert zunächst alles aktuell Passende
  (sortiert nach `ts`), danach laufend nur noch Neues/Geändertes. Der
  interne Abgleich verhindert Race-Doppelzustellungen exakt (Schlüssel
  `id|ts`, nicht nur `id` — ein LWW-Update auf dieselbe `id` wird trotzdem
  zugestellt).
- **`{ once: true }`** — liefert alles aktuell Passende, dann nichts mehr;
  keine laufende Subscription. Entspricht inhaltlich `query()`, aber über
  dasselbe Callback-Interface wie der Rest.
- Ohne beides: unverändertes Verhalten (Standard, damit kein bestehender
  Aufrufer betroffen ist).

**Wichtig bei `initial`/`once`:** `on()` selbst bleibt synchron (gibt immer
sofort eine Unsubscribe-Funktion zurück, auch während der interne
Nachhol-Abruf noch läuft — ein Aufruf dieser Funktion vor Abschluss
unterdrückt die Zustellung vollständig). Die Elemente des initialen Batches
werden per `for`-Schleife ohne `await` zwischen den Aufrufen an `callback`
übergeben — bei einem `async`-`callback` laufen mehrere Aufrufe dadurch
potenziell nebenläufig (in `ts`-Reihenfolge GESTARTET, aber nicht
zwingend in dieser Reihenfolge ABGESCHLOSSEN). Für streng sequenzielle
Verarbeitung weiterhin manuell `for (const q of await runtime.query(p)) await callback(q)` nutzen.

```js
// Chat-Historie laden + live weiterhören, ohne die Lücke selbst zu bauen:
runtime.on(`${room}/msgs/**`, renderMessage, { initial: true });

// Einmaliger Snapshot über dasselbe Interface wie der Rest der API:
runtime.on(`${room}/msgs/**`, renderMessage, { once: true });
```

### `runtime.emit(topic, payload?)`
Ephemeres, ungespeichertes, ungesigntes Event (z. B. `sync.complete`) —
dispatcht über denselben Subscription-Mechanismus wie `on()`, aber ohne
Store-Write. Konsumenten sehen `{ id: topic, ...payload, ephemeral: true }`.
`{ initial, once }` sind hier ohne Wirkung (es gibt nichts Gespeichertes,
das ein Nachhol-Abruf finden könnte).

### `runtime.nextTs()` → `number`
Nächster Wert der geteilten HLC-Uhr (Wall-Time + Fractional-Sequence).
Mehrere `Session`s auf derselben `Runtime` teilen sich diese Uhr für
konsistente Ordering-Entscheidungen.

### `runtime.store` → `QuStore`
Read-only Zugriff auf die zugrunde liegende Store-Instanz.

```js
const runtime = new QuRuntime({ store });
runtime.use(createVerifyPlugin());
runtime.on('chat/**', (q) => console.log(q.value));
await runtime.publish('chat/room1/msg1', 'hello');
```

---

## QuStore

Persistenz über Mounts (Präfix → Adapter). Verändert, entschlüsselt,
interpretiert nie den `value` eines QuBits.

### `new QuStore(mounts)`
```ts
interface Mount { prefix: string; adapter: StorageAdapter; replicate?: boolean } // default: true
```
Mounts werden nach längstem Präfix zuerst geprüft — spezifischere Mounts
gewinnen. Ein Mount ohne `replicate: false` ist implizit replizierbar.

### `store.get(id)` / `store.put(qubit)` / `store.query(prefix)`
Direkte Adapter-Durchreichung; `put()` ist idempotent (gleicher `ts` = Noop,
kleinerer `ts` wird verworfen — das ist die "unveränderliche Daten"-Garantie
auf Store-Ebene).

### `store.mountFor(id)` → `string`
Liefert das zuständige Mount-Präfix.

### `store.isReplicable(id)` → `boolean`
Prüft das `replicate`-Flag des zuständigen Mounts. **Muss** von jeder
Replication-Implementierung vor dem Versenden geprüft werden (siehe
`DefaultReplication`) — eine unabhängige, harte Schranke *vor* jeder ACL.

```js
const store = new QuStore([
  { prefix: '', adapter: new MemoryAdapter() },              // Standard
  { prefix: 'presence/', adapter: new NullAdapter() },        // reiner Event-Bus, nichts wird gespeichert
  { prefix: 'private/', adapter: new MemoryAdapter(), replicate: false }, // verlässt nie das Gerät
]);
```

---

## QuSession

Identität, Verschlüsselung, optionale lokale ACL-Filterung — alles, was der
Core bewusst nicht kennt.

### `new QuSession(runtime, { identity?, getACL? })`
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `identity` | `QuIdentity \| null` | `null` | Signiert Writes; `null` = anonyme/read-only Session |
| `getACL` | `GetACL \| null` | `null` | Optional: filtert auch lokale `get()`/`query()`-Ergebnisse (z. B. `createSpaceACLResolver(runtime)`) |

### `session.publish(id, value, opts?)`
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `opts.ts` | `number` | `runtime.nextTs()` | expliziter Zeitstempel |
| `opts.refs` | `string[]` | — | Referenzen auf andere QuBit-IDs (Listen, Anhänge, Space-Links) — Teil der Signatur |
| `opts.encryptFor` | `string[] \| null \| undefined` | — | Fingerprints der Empfänger; verschlüsselt `value` vor dem Signieren (ECDH+HKDF+AES-256-GCM). `undefined` (Parameter weggelassen) löst den **Default** unten aus; `null`/`[]` schreibt explizit im Klartext |

Signiert (falls `identity` gesetzt), dann `runtime.ingest()`.
**Rückgabe:** wie `runtime.ingest()`.

**Default-Verschlüsselung an alle Reader eines Space:** wird `encryptFor`
komplett weggelassen (nicht `null`/`[]` — das sind ein bewusstes Opt-out) UND
ist `getACL` gesetzt (jede über `Qu` erzeugte Session hat das), wird die
`readers`-Liste des Ziel-Space live nachgeschlagen (`getACL(id)`). Ist sie
etwas anderes als `['*']`, wird automatisch genau für diese Leser (plus den
Schreiber selbst, falls nicht ohnehin enthalten) verschlüsselt — Empfänger,
deren Schlüssel noch nicht per `trustPeer()` bekannt sind, werden dafür
automatisch über ihr veröffentlichtes `~<fp>/epub` aufgelöst (siehe
[`qu.publishProfile()`](#profil-qupublishprofile-qureadprofilefingerprint)).
Ohne Spaces-Plugin oder mit `readers: ['*']` ist `getACL()` immer
`{readers: ['*']}` — der Default ist dort ein reines No-op, unverändertes
Verhalten. Zwei Ausnahmen, unabhängig vom `readers`-Wert: das Space-Manifest
selbst (`id === spaceId`, sonst könnte `getACL()` sich nicht mehr selbst
lesen) und die drei reservierten Profil-Leaves (`~<fp>/pub|epub|alias`) sind
niemals Teil dieses Defaults — beide müssen strukturell im Klartext bleiben.
Ein fehlender Empfänger-Key wirft einen klaren Fehler (`Unknown ECDH public
key for recipient "…"`) statt still im Klartext zu schreiben.

```js
// readers: ['*'] (Default) — encryptFor bleibt komplett ungenutzt, wie bisher.
await qu.get(publicRoomId).get('msgs').set({ text: 'hallo' });

// readers: [alice.fp, bob.fp] — automatisch für genau diese beiden verschlüsselt,
// sobald beide zuvor publishProfile() aufgerufen haben.
await qu.get(privateRoomId).get('msgs').set({ text: 'geheim' });

// Bewusst im Klartext, auch in einem eingeschränkten Space:
await qu.get(privateRoomId).get('meta').put({ createdAt: Date.now() }, { encryptFor: null });
```

### `session.append(collectionId, value, opts?)`
Wie `publish()`, aber hängt zuerst `${identity.fingerprint}-${ts}` als EIN
Pfadsegment an `collectionId` an (nicht zwei Segmente
`${fingerprint}/${ts}` — damit bleibt die entstehende Collection genauso
eine Ebene tief wie eine `put()`-basierte, `node.map(cb)` braucht kein
`{ deep: true }`, um sie zu finden). **Erfordert eine Identität** (wirft
sonst — ein anonymer Schreiber kann nicht sinnvoll namensraumisiert
werden). Für Sammlungen mit mehreren unabhängigen Schreibern
(Chat-Nachrichten, Kommentare) statt `publish()` mit einer selbstgewählten
ID — siehe die `publish` vs. `append`-Erklärung im
[`Qu`-Abschnitt](#qu-facade-empfohlener-einstieg).

### `session.get(id)` → `Promise<QuBit | null>`
Wie `runtime.get()`, aber: entschlüsselt automatisch, falls adressiert
(sonst `{ ...qubit, value: undefined, encrypted: true }`); filtert über
`getACL`, falls gesetzt.

### `session.query(pattern)` → `Promise<QuBit[]>`
Wie `session.get()`, für mehrere Treffer.

### `session.on(pattern, callback, opts?)` → `() => void`
Wie `runtime.on()` (inkl. `{ initial, once }`, siehe dort), aber `callback`
erhält bereits entschlüsselte QuBits — sowohl im initialen Batch als auch
laufend, damit es sich identisch zu `session.query()` verhält.

### `session.trustPeer(fingerprint, encPubKeyJwk)`
Merkt sich den ECDH-Public-Key eines anderen Fingerprints, damit
`encryptFor` diesen adressieren kann. In der Praxis meist aus dem
öffentlichen Profil des Peers gelesen (`~<fp>/epub`, siehe
[Profil](#qu-facade-empfohlener-einstieg) oben), nicht manuell verteilt.

### `session.resolveRefs(qubit)` → `Promise<(QuBit | null)[]>`
Lädt (und entschlüsselt, falls möglich) alle in `qubit.refs` referenzierten
QuBits. Manuell, keine automatische Reaktivität.

```js
const alice = await QuIdentity.generate();
const session = new QuSession(runtime, { identity: alice, getACL: createSpaceACLResolver(runtime) });

await session.trustPeer(bob.fingerprint, bobEpubJwk);
await session.publish('dm/msg1', { text: 'hi' }, { encryptFor: [alice.fingerprint, bob.fingerprint] });
```

---

## QuIdentity

Signier- (ECDSA P-256) und Verschlüsselungs-Schlüsselpaar (ECDH P-256).
`fingerprint = hash(publicSigningKey)` — die Basis für Zero-Trust.

### `QuIdentity.generate()` → `Promise<QuIdentity>`
Erzeugt ein neues Schlüsselpaar.

### `QuIdentity.importKeys(signPriv, signPub, encPriv, encPub)` → `Promise<QuIdentity>`
Rekonstruiert eine Identity aus zuvor exportierten JWKs (z. B. aus sicherem
lokalem Storage geladen).

### `identity.fingerprint` → `string`
`hash(publicSigningKey)`, gekürzt auf 24 Hex-Zeichen. Adressierbar als
`~<fingerprint>` (User-Space, siehe Space-Helfer).

### `identity.sign(data)` → `Promise<string>`
ECDSA-Signatur (Hex) über einen beliebigen String — intern für
`canonical(qubit)` genutzt, direkt aufrufbar z. B. für den
Channel-Handshake.

### `identity.exportPublicSigningKey()` → `Promise<JsonWebKey>`
Der öffentliche Signierschlüssel als JWK — wird jedem signierten QuBit
mitgegeben (self-certifying).

### `identity.exportKeys()` → `Promise<{ signPub, signPriv, encPub, encPriv }>`
Alle vier Schlüssel als JWK, für Speicherung oder Weitergabe von `encPub`
(z. B. im öffentlichen Profil, damit andere `trustPeer()` aufrufen können).

### `identity.encryptionKey` / `identity.encryptionPrivateKey`
ECDH-`CryptoKey`-Paar, intern von `crypto/encrypt.js` genutzt.

---

## Channel & Handshake

Der Transport-Contract, den Replication/Files-Module voraussetzen — nichts
Konkretes (WebSocket etc.) ist im Core enthalten.

```ts
interface Channel {
  readonly id: string;
  connect(): Promise<void>;
  send(message: object): Promise<void>;
  onMessage(handler: (msg: object) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): Promise<void>;
}
```

### `assertChannel(obj)` → `obj`
Wirft, falls `obj` den Contract nicht erfüllt — frühes, klares Scheitern
statt kryptischer Fehler drei Aufrufe später.

### `createLoopbackChannelPair(idA?, idB?)` → `{ a: Channel, b: Channel }`
In-Process-Channel-Paar für Tests/Demos. **Kein** Produktions-Transport.

### `authenticateChannel(channel, identity)` → `Promise<string | null>`
Gegenseitige Challenge-Response: jede Seite signiert eine vom Gegenüber
gewählte Zufallszahl mit derselben Identity, die auch QuBits signiert.
**Rückgabe:** der kryptographisch bewiesene Fingerprint der Gegenseite
(`null`, falls die Gegenseite anonym ist, also ohne `identity` aufgerufen
wurde).

```js
const { a, b } = createLoopbackChannelPair();
const [peerOfA, peerOfB] = await Promise.all([authenticateChannel(a, alice), authenticateChannel(b, bob)]);
// peerOfA === bob.fingerprint, peerOfB === alice.fingerprint
```

---

## Space-Helfer

Reine String-Konventionen, keine ACL-Logik selbst (die liegt im
Spaces-Modul).

| Funktion | Rückgabe | Beschreibung |
|---|---|---|
| `spaceIdOf(id)` | `string` | Erstes Pfadsegment einer QuBit-ID |
| `isUserSpaceId(spaceId)` | `boolean` | Beginnt mit `~` |
| `userSpaceId(fingerprint)` | `string` | `"~" + fingerprint` |
| `fingerprintOfUserSpace(spaceId)` | `string \| null` | Kehrfunktion zu `userSpaceId` |
| `randomSpaceId()` | `string` | `crypto.randomUUID()` — für generische Spaces |

---

## Adapter

### `StorageAdapter`-Contract (implementiert von `MemoryAdapter`, `NullAdapter`)
```ts
interface StorageAdapter {
  get(id: string): Promise<QuBit | null>;
  put(id: string, q: QuBit): Promise<void>;
  delete(id: string): Promise<void>;
  getAll(prefix?: string): Promise<QuBit[]>;
}
```
- **`MemoryAdapter`** — flüchtiger Map-basierter Speicher. Für Tests, Demos,
  oder Anwendungen ohne Persistenzbedarf.
- **`NullAdapter`** — speichert nichts (`get`/`getAll` liefern immer
  leer/`null`), dispatcht aber trotzdem normal. Für reine Event-Bus-Mounts
  (Presence, Live-Ticker).

### `FileStorageAdapter`-Contract (implementiert von `MemoryFileStorageAdapter`)
```ts
interface FileStorageAdapter {
  putChunk(hash: string, bytes: Uint8Array): Promise<void>;
  getChunk(hash: string): Promise<Uint8Array | null>;
  hasChunk(hash: string): Promise<boolean>;
  deleteChunk(hash: string): Promise<void>;
}
```
Content-adressiert (Schlüssel = SHA-256-Hash der Bytes), getrennt vom
`StorageAdapter`-Contract — siehe Files-Modul.

---

## Plugins

### `createVerifyPlugin(known?)` → `Middleware`
Zero-Trust-Kern: rekonstruiert den Fingerprint aus dem im QuBit
mitgelieferten `pubKey` und verwirft, falls er nicht zu `writer` passt, oder
falls die Signatur nicht über `canonical(qubit)` passt. `known` (optional,
`{ [fingerprint]: CryptoKey }`) ist ein Performance-Cache, keine
Vertrauensquelle — die Prüfung funktioniert auch für nie zuvor gesehene
Fingerprints korrekt.

### `createACLPlugin(getACL)` → `Middleware`
Write-ACL, läuft nach Verify. `getACL(id)` liefert
`{ writers: string[] | ['*'], readers: string[] | ['*'] } | null`
(`null`/kein `writers`-Feld = keine Einschränkung).

### `filterForReader(qubits, readerFingerprint, getACL)` → `Promise<QuBit[]>`
Read-Filter, **zwingend** vor jedem Versand über einen Channel aufzurufen
(siehe `DefaultReplication`). Bündelt nach Space (`spaceIdOf`) — ein
`getACL`-Aufruf pro Space in der Liste, nicht pro QuBit.

---

## Spaces-Modul

### `createSpaceACLResolver(runtime)` → `GetACL`
Manifest-basierter ACL-Resolver, direkt einsetzbar in
`createACLPlugin()`/`filterForReader()`/`QuSession({ getACL })`.
- **User-Space** (`~<fp>`): `<fp>` ist immer Writer/Admin, mit oder ohne
  Manifest, nicht entfernbar durch das Manifest selbst.
- **Generischer Space** (UUID): ohne Manifest darf jeder schreiben
  (First-Write-Wins-Bootstrap); mit Manifest gilt es. Das Manifest selbst
  darf nur von `admins` geändert werden.

### `createSpace(session, { writers?, readers?, admins? })` → `Promise<SpaceId>`
Erzeugt einen neuen generischen Space: generiert eine UUID, **awaitet** das
Manifest-QuBit (`session.publish(spaceId, { admins, writers, readers, createdAt })`,
`admins` defaultet auf `[session.fingerprint]`) und liefert die rohe Id
erst zurück, wenn es wirklich geschrieben ist —
im Gegensatz zur Fassaden-Sugar-Methode `qu.createSpace(opts)` (siehe
[`QuSpace`](#quspace)), die synchron einen `QuSpace`-Node liefert und das
Manifest fire-and-forget im Hintergrund schreibt. Für Aufrufer, die eine
GARANTIERT durchgeschriebene Id brauchen, bevor sie weitermachen (z. B. eine
Id, die sofort an jemand anderen weitergegeben wird), ist diese Funktion
die robustere Wahl — `qu.createSpace(opts).ready` ist die äquivalente
Garantie über die Fassade.

```js
const acl = createSpaceACLResolver(runtime);
runtime.use(createACLPlugin(acl));
const session = new QuSession(runtime, { identity: alice, getACL: acl });

const roomId = await createSpace(session, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });
await session.publish(`${roomId}/msg1`, { text: 'hi' });
```

### `createSpaceAt(session, id, { writers?, readers?, admins? })` → `Promise<SpaceId>`
Wie `createSpace()`, aber mit einer selbst gewählten `id` statt einer
generierten UUID — liefert exakt diese `id` zurück, erst nachdem das
Manifest wirklich geschrieben ist. Für einen App-weiten, fest bekannten
Space (ein App-Space) statt eines neu erzeugten Raums pro Aufruf; die
Fassaden-Sugar-Entsprechung ist `qu.createSpaceAt(id, opts)` (siehe
[`QuSpace`](#quspace) oben).

---

## Replication-Modul

### `ReplicationProvider`-Contract
```ts
interface ReplicationProvider {
  sync(opts: { topic: string; since?: number }): Promise<number>;   // neuer since-Cursor
  repair(opts: { topic: string; since?: number }): Promise<number>;
  snapshot(opts: { topic: string }): Promise<number>;
  listen(): void;
}
```
`assertReplicationProvider(obj)` prüft den Contract (analog `assertChannel`).

### `new DefaultReplication(runtime, channel, opts?)`
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `opts.getACL` | `GetACL` | `async () => null` | Read-ACL für ausgehende Daten |
| `opts.peerFingerprint` | `string \| null` | `null` | Sollte aus `authenticateChannel()` stammen, nicht geraten werden |
| `opts.repairWindowMs` | `number` | `300000` (5 Min) | Überlappungsfenster für `repair()` |
| `opts.pushTopics` | `string[]` | `[]` | Präfixe, für die neu eingehende QuBits sofort live gepusht werden |

- **`sync({ topic, since? })`** — Delta-Anfrage; **reziprok**: die
  Gegenseite fragt automatisch dasselbe Topic zurück, ein Aufruf leert also
  beide Richtungen (schließt die "Offline-Queue"-Frage ohne Extra-Struktur).
- **`repair({ topic, since? })`** — wie `sync()`, aber mit
  `since - repairWindowMs` als Startpunkt; erneute Zustellung ist dank
  Store-Idempotenz sicher.
- **`snapshot({ topic })`** — `sync({ topic, since: 0 })`.
- Jede ausgehende Antwort wird zuerst gegen `store.isReplicable()`, dann
  gegen `filterForReader()` geprüft — beides Pflicht, nicht Option.
- **`replication.peerFingerprint`** — der bewiesene Fingerprint der
  Gegenseite (wie beim Konstruktor übergeben), zur Introspektion.
- **`close()`** — Listener abmelden.

### `new ReplicationHub(runtime, { identity?, getACL?, pushTopics? })`
Verwaltet eine `DefaultReplication`-Instanz pro `Channel` — für einen
Server-Prozess mit vielen gleichzeitig verbundenen Clients.
- **`hub.attach(channel)`** → `Promise<{ repl: DefaultReplication, peerFingerprint }>`
  — führt zuerst `authenticateChannel()` aus, erzeugt danach die
  `DefaultReplication` mit dem bewiesenen Fingerprint.
- **`hub.detach(channelId)`**, **`hub.get(channelId)`**, **`hub.size`**,
  **`hub.broadcastSync({ topic })`**.

---

## References-Modul

`src/data/references.js` — ein URI-Schema für Verweise zwischen QuBits, rein
manuell/opt-in (kein automatischer Read-Hook in `get()`, gleiche Philosophie
wie überall: der Core bleibt ein dummer Store, die App entscheidet, wann sie
einem Link folgt). Nichts hier schreibt eine Referenz automatisch — auch der
`FileHandler` nicht (siehe unten): das Schreiben einer Referenz ist immer
ein expliziter, eigener Aufruf.

### `isReference(value)` → `boolean`
`true`, wenn `value` ein String im Format `obj://…`/`key://…`/`file://…` ist.

### `parseReference(ref)` → `{ scheme, path }`
Zerlegt einen Referenz-String. Wirft, falls `ref` keinem der drei Schemata entspricht.

### `keyRef(path)` / `objRef(path)` / `fileRef(manifestId)` → `string`
Bauen den jeweiligen Referenz-String, statt ihn von Hand zusammenzusetzen
(`` `key://${path}` `` usw.) — bevorzugt gegenüber manuellem
Zusammenbau, damit ein Tippfehler im Schema-Präfix nicht erst beim
Auflösen aussieht wie "keine Referenz gefunden".

**Explizit eine Referenz AUF EINEN ANDEREN SPACE schreiben** — die direkte
Antwort auf "wie schreibe ich selbst eine Referenz": eine Referenz ist
IMMER ein normaler `put()`/`set()`-Aufruf mit einem `key://`/`obj://`-String
als `value`, nichts Spezielleres:

```js
const otherSpace = qu.createSpace({ writers: [qu.fingerprint], readers: ['*'] });
await otherSpace.ready;

// Zeigt auf GENAU EINEN Wert — hier: den Space selbst (sein Root-QuBit,
// z. B. das Manifest oder was auch immer dort per put() liegt):
await myNode.put(keyRef(otherSpace.id));

// Zeigt auf die DIREKTEN KINDER eines Pfads, zu einem Objekt/Array
// gesammelt — für "eine Liste/Sammlung referenzieren", nicht den Space
// selbst. `obj://<spaceId>` OHNE Unterpfad sammelt nur, was direkt AN
// `spaceId` selbst hängt (`${spaceId}/*`) — meist eher
// `obj://<spaceId>/<collectionPath>`, z. B. eine set()-Sammlung:
await myNode.put(objRef(`${otherSpace.id}/entries`));
```

`myNode.put(otherSpace)` (die `QuSpace`-INSTANZ direkt als Wert, nicht als
String) ist dagegen KEINE gültige Referenz und wirft jetzt einen klaren
Fehler: lokal sähe es noch fast richtig aus (die Instanz landet einfach roh
im `MemoryAdapter`), aber sobald der QuBit eine echte Serialisierungsgrenze
überquert (Netzwerk-Versand, Persistenz über einen echten
`StorageAdapter`), kollabiert `JSON.stringify` die Instanz über ihre
`toJSON()` zur nackten Id — OHNE `key://`-Präfix, für
`isReference()`/`resolveReference()` danach nicht mehr als Referenz
erkennbar. `node.put(keyRef(otherSpace.id))` (die explizite String-Form)
ist der einzige korrekte Weg.

### `resolveReference(qu, ref, { maxDepth?, asArray?, fileHandler? })` → `Promise<any>`
Löst einen einzelnen Referenz-String auf. `maxDepth` (Default `1`) begrenzt,
wie viele weitere Referenzen INNERHALB des aufgelösten Werts noch
kaskadiert werden (die übergebene Referenz selbst wird immer aufgelöst,
unabhängig vom Budget); ein Ref, der auf sich selbst zurückführt, bleibt ab
dem zweiten Auftreten im selben Pfad unaufgelöst statt zu hängen.
`asArray: true` (nur `obj://`) liefert ein nach Zeilenschlüssel sortiertes
Array statt eines Objekts. `fileHandler` (optional) lässt `file://` zu
echten Bytes auflösen statt zum rohen Manifest (siehe Files-Modul unten).

### `resolveValue(qu, value, opts)` → `Promise<any>`
Wie `resolveReference()`, aber läuft einen beliebigen Wert (z. B. ein
ganzes `qubit.value`) ab und löst JEDE Referenz-Zeichenkette auf, die
irgendwo darin gefunden wird — statt zu verlangen, dass der Top-Level-Wert
selbst schon eine Referenz ist.

### `resolveKeyChain(session, id, { maxHops? })` → `Promise<{ id, qubit }>`
Folgt einer Kette von `key://`-Weiterleitungen, beginnend AN `id` selbst
(nicht an einem Wert darin) — der Mechanismus hinter der transparenten
Referenz-Auflösung in `put`/`set`/`on`/`map`/`await` (siehe unten und
[README Abschnitt 8](./README.md#8-referenzen-automatisch-folgen-key)).
Bewusst enger als `resolveReference()`/`resolveValue()`: nur `key://` wird
gefolgt (ein Wert AN einer anderen Id — der "weiter navigieren"-Fall).
`obj://` (eine Sammlung) und `file://` (Bytes) werden auch hier NICHT
automatisch weiterverfolgt — deren aufgelöste FORM ist keine "Wert an
einer Id" (ein Array/Objekt bzw. rohe Bytes), das würde den Rückgabetyp
unvorhersagbar machen. Liefert `{ id, qubit }` — die finale,
nicht-weiterleitende Id und was dort tatsächlich liegt (`qubit: null`,
falls nichts). `id` spiegelt wider, wo die Auflösung TATSÄCHLICH gelandet
ist, nicht die übergebene Id — so navigiert man ohne eigenes Verb weiter:
`qu.get(result.id)`. `maxHops` (Default `8`) begrenzt verkettete
Weiterleitungen; wirft einen klaren Fehler bei einem Zyklus (dieselbe Id
taucht in der Kette erneut auf) oder wenn das Budget überschritten wird.

### `createReferenceHandlerPlugin({ maxDepth?, asArray?, fileHandler?, maxHops? })`
`qu.use(...)` hängt `qu.resolveReference(ref, opts)`/`qu.resolveValue(value, opts)`
mit `maxDepth`/`asArray`/`fileHandler` als Defaults an (weiterhin pro
Aufruf überschreibbar), UND installiert per `qu.setResolveHandler()` den
`resolveKeyChain()`-basierten Resolver, den JEDER `QuSpace`-Node
(`qu.get(id)`/`qu.own`/`qu.createSpace()`/`qu.createSpaceAt()`) für
`put`/`set`/`on`/`map`/`await` standardmäßig nutzt (`maxHops` steuert
dessen Ketten-Budget). Ohne dieses Plugin ist `resolveDispatch` die
Identitätsfunktion — Core importiert diese Datei nie und weiß nicht, dass
`key://` etwas Besonderes bedeutet.

**Transparente Referenz-Auflösung — Default AN, `{ raw: true }` schaltet
sie ab:** mit installiertem Plugin folgen `await node`, `node.put()`,
`node.set()`, `node.on()`, `node.map()` einer `key://`-Referenz AN der Id,
auf der sie jeweils aufgerufen werden, transparent — kein zusätzlicher
Read gegenüber heute im referenzfreien Normalfall (der Wert wird ohnehin
gelesen). Vollständige Erklärung, Beispiele und die vier Fallstricke (kein
Mid-Path-Auflösen, nur `key://` automatisch, `on`/`map` lösen einmalig
beim Aktivieren nicht pro Event, `{ raw: true }`/`node.session.get(node.id)`
als Escape-Hatches) stehen in
[README Abschnitt 8](./README.md#8-referenzen-automatisch-folgen-key) —
hier nur die Kurzfassung pro Verb:

| Verb | Verhalten mit installiertem ReferenceHandler |
|---|---|
| `await node` | Löst `node.id` durch eine `key://`-Kette auf; das zurückgegebene QuBit trägt die ECHTE aufgelöste `.id`, nicht den Alias-Pfad. Kein `raw`-Parameter möglich (Thenable-Protokoll) — `await node.session.get(node.id)` ist die unaufgelöste Entsprechung. |
| `node.put(value, opts)` | Löst `node.id` zuerst auf, schreibt dann am aufgelösten Ziel (dessen ACL gilt). `{ raw: true }` schreibt an der wörtlichen Id. |
| `node.set(value, opts)` | Wie `put()`, aber der neue Sammlungs-Eintrag landet unter der aufgelösten Ziel-Id. `{ raw: true }` verhält sich wie zuvor. |
| `node.on(cb, opts)` | Löst `node.id` EINMALIG beim Aktivieren auf, abonniert danach die aufgelöste Id — nie erneut pro Event. Liefert weiterhin sofort eine Unsubscribe-Funktion zurück (Auflösung + echtes Abonnement laufen im Hintergrund, Abbruch vorher ist sicher). `{ raw: true }` verhält sich exakt wie vor dieser Funktion (rein synchron, kein Setup-Gap). |
| `node.map(cb, opts)` | Wie `on()`, aber das aufgelöste Ziel wird mit `*`/`**` für die Kinder-Subscription verwendet. `{ raw: true }` wie zuvor. |

---

## Files-Modul

### `publishFile(session, id, bytes, opts)` → `Promise<{ manifestId, manifest, ...ingestResult }>`
| Parameter | Typ | Default | Beschreibung |
|---|---|---|---|
| `id` | `string` | — | QuBit-ID des Manifests (liegt üblicherweise im Space des umgebenden Inhalts) |
| `bytes` | `Uint8Array` | — | Dateiinhalt |
| `opts.name`, `opts.mime` | `string` | — / `'application/octet-stream'` | Metadaten |
| `opts.chunkSize` | `number` | `65536` (64 KiB) | Chunk-Größe |
| `opts.fileStorage` | `FileStorageAdapter` | **erforderlich** | Wohin die Chunks geschrieben werden |
| `opts.refs`, `opts.encryptFor` | — | — | Wie bei `session.publish()` |

Zerlegt `bytes` in Chunks, hasht jeden (SHA-256), speichert sie im
`fileStorage`, veröffentlicht das Manifest als normales, signiertes QuBit.

### `reassembleFile(fileStorage, manifest)` → `Promise<Uint8Array | null>`
Fügt Chunks in Manifest-Reihenfolge zusammen; `null`, falls ein Chunk fehlt.

### `missingChunks(fileStorage, manifest)` → `Promise<string[]>`
Hash-Liste der noch fehlenden Chunks — Grundlage für Resume/Diff.

### `new DefaultFileTransfer(runtime, channel, fileStorage)`
- **`requestFile(manifestId)`** — holt das Manifest (lokal oder per
  Anfrage, dann `runtime.ingest()` — derselbe Verify-/ACL-Pfad wie jedes
  andere QuBit), fordert nur fehlende Chunks an, verwirft jeden Chunk, dessen
  tatsächlicher Hash nicht zum angefragten passt (nie gespeichert).
- **`hasComplete(manifestId)`** → `Promise<boolean>`.
- **`close()`**.

```js
const fileStorage = new MemoryFileStorageAdapter();
const { manifestId } = await publishFile(session, `${roomId}/files/agenda`, bytes, { name: 'agenda.txt', fileStorage });

const xfer = new DefaultFileTransfer(runtime, channel, remoteFileStorage);
await xfer.requestFile(manifestId);
const file = await reassembleFile(remoteFileStorage, (await runtime.get(manifestId)).value);
```

---

## Chat-Modul

Ein Raum (1:1 oder Gruppe — kein Unterschied im Modell, nur die
Mitgliederliste im Manifest unterscheidet sich) ist ein gewöhnlicher Space
(siehe [Spaces-Modul](#spaces-modul)). Dieses Modul trägt selbst keine
Sicherheitslogik bei — die Kollisionssicherheit kommt vollständig aus
`set()` (siehe [`QuSpace`](#quspace)); hier steht nur bequeme Namensgebung
und Anhang-Behandlung obendrauf. Jede Funktion außer `createChatRoom()`
nimmt einen bereits navigierten Space-Node entgegen (`qu.get(spaceId)`)
statt eines `(qu, spaceId)`-Paars und ist intern nur eine kurze
get/put/set/map-Kombination.

### `createChatRoom(qu, memberFingerprints, { readers? })` → `QuSpace`
**Synchron** (wie `qu.createSpace()`, das es aufruft — siehe
[`QuSpace`](#quspace) dazu, warum). `readers` defaultet auf
`memberFingerprints` (nur Mitglieder lesen). Für einen öffentlich lesbaren
Raum explizit `readers: ['*']` übergeben.

Diese eingeschränkte `readers`-Liste ist genau der Fall, der
`session.publish()`s Default-Verschlüsselung auslöst (siehe
[`session.publish()`](#sessionpublishid-value-opts)): jede Nachricht/jeder
Anhang in einem so erzeugten Raum wird automatisch für alle Mitglieder
verschlüsselt, sofern niemand explizit `encryptFor` übergibt. Voraussetzung:
**jedes Mitglied ruft vor der ersten Nachricht einmal
[`qu.publishProfile()`](#profil-qupublishprofile-qureadprofilefingerprint)
auf** — sonst schlägt das Verschlüsseln mit einem klaren Fehler fehl, weil
der Sender den ECDH-Key eines Mitglieds nicht auflösen kann. `room.ready`
abwarten, bevor andere Mitglieder sofort mitschreiben sollen.

### `sendMessage(space, { text, attachments?, encryptFor? })`
| Parameter | Typ | Beschreibung |
|---|---|---|
| `attachments` | `{ bytes, name, mime, fileStorage }[]` | Jeder Anhang wird über `put()` geschrieben (Datei-Auto-Detect, chunked+manifested — siehe [`QuSpace`](#quspace)), kollisionssicher adressiert wie Nachrichten selbst, und per `refs` an die Nachricht gehängt — Foto, Video und beliebige Datei unterscheiden sich nur im `mime`-Feld. |
| `encryptFor` | `string[] \| null` | Explizit übersteuern. Weggelassen greift der Default aus `session.publish()` — bei einem Raum mit eingeschränkten `readers` also bereits automatisch verschlüsselt, ohne dass diese Funktion selbst etwas dafür tun muss. |

Ruft intern `space.get('msgs').set({ text }, { refs, encryptFor })` auf.

### `listMessages(space)` → `Promise<QuBit[]>`
Alle Nachrichten, älteste zuerst (`space.session.query()` + Sortierung nach
`ts`). Jede trägt weiterhin ihr geprüftes `writer`-Feld — **eine Oberfläche
muss dieses Feld für die Autorenanzeige nutzen, nie den ID-Text
interpretieren** (siehe Warnung unten).

### `onMessage(space, callback, opts?)` → `() => void`
Live-Subscription auf neue Nachrichten (`space.get('msgs').map(callback, opts)`
unter der Haube). `onReadReceipt(space, callback, opts?)` und
`onPresenceChange(space, callback, opts?)` verhalten sich identisch.

### Read-Receipts & Presence
`markRead(space, uptoTs)` / `getReadReceipts(space)` — ein LWW-Slot pro
Leser (`space.get('reads/${fingerprint}').put({ upTo })`). `setPresence(space,
status)` / `getPresence(space, { staleAfterMs? })` / `startHeartbeat(space,
{ intervalMs? })` → `() => Promise<void>` (stop-Funktion) — derselbe
Heartbeat-auf-festem-Slot-Mechanismus wie zuvor, nur auf einen Space-Node
statt `(qu, spaceId)` bezogen.

> **Wichtig:** Die ID einer Nachricht enthält den Fingerprint des
> Schreibers nur als Adressierungs-Konvention (damit verschiedene
> Schreiber nie kollidieren, siehe `set()`) — sie ist **keine
> Vertrauensquelle**. Ein böswilliger Schreiber kann einen Pfad konstruieren,
> der wie der Namensraum eines anderen aussieht (`.../msgs/<fremder-fp>/...`)
> — das signierte `writer`-Feld des empfangenen QuBits bleibt davon
> unberührt und zeigt weiterhin unweigerlich den tatsächlichen Autor. Jede
> Chat-Oberfläche muss Autorschaft ausschließlich aus `writer` ableiten.

### `createChatPlugin()` — Fassaden-Sugar
`qu.use(createChatPlugin())` hängt `qu.createChatRoom(memberFingerprints, opts?)`,
`qu.sendMessage(spaceId, opts?)`, `qu.listMessages(spaceId)`,
`qu.onMessage(spaceId, cb, opts?)` (und die Read-Receipt-/Presence-
Äquivalente) an — jede löst `spaceId` nur zu `qu.get(spaceId)` auf und
delegiert an die Funktion oben.

```js
const alice = (await Qu.create()).use(createSpacesPlugin()).use(createChatPlugin());
const bob = (await Qu.create({ runtime: alice.runtime })).use(createChatPlugin());
const room = alice.createChatRoom([alice.fingerprint, bob.fingerprint]); // synchron
await room.ready;

await alice.sendMessage(room.id, { text: 'hey bob' });
await alice.sendMessage(room.id, {
  text: 'ein Bild',
  attachments: [{ bytes: imageBytes, name: 'photo.png', mime: 'image/png', fileStorage }],
});

// Historie + live weiterhören in einem Aufruf, statt map() von Hand zu bemühen:
bob.onMessage(room.id, (msg) => console.log(msg.writer, msg.value.text), { initial: true });
```

---

## UI-Bindings-Modul

Reaktive View-/Bindung-Primitive in reinem JS (`src/ui/bindings.js`) —
DOM-Library-agnostisch (kein `document.*` in dieser Datei; `createItem`/
`render`/Element-Get-Set kommen vom Aufrufer), fully unit-testbar mit
Mock-Objekten statt einem echten Browser (siehe `test/ui-bindings.test.mjs`).
Jede Funktion nimmt einen bereits navigierten Node entgegen (`qu.get(id)`,
siehe [`QuSpace`](#quspace)) statt eines `(qu, id)`-Paars. Basis für das
[UI-Components-Modul](#ui-components-modul) darunter — eine Component IST
nichts als eine dieser Funktionen, aufgerufen aus `connectedCallback()`,
mit dem zurückgegebenen `off()` in `disconnectedCallback()`.

### `viewKey(node, render)` → `() => void`
One-way, ein einzelner Node. `render(value, qubit)` läuft einmal für den
aktuellen Stand (via `node.on(cb, { initial: true })`), danach bei jeder
Änderung. Dedupliziert über `(id, ts)`, nicht per Wertevergleich — dieselbe
Idee wie `QuStore.put()`s Same-ts-Noop-Check.

### `viewObject(node, { createItem, render, key?, deep? })` → `() => void`
One-way, eine Sammlung. Jeder QuBit direkt unter `node` (`node.map()`
unter der Haube — findet `set()`-Sammlungen bereits ohne `deep`, die sind
genauso eine Ebene tief wie `put()`-Sammlungen; `deep: true` für
`${node.id}/**` nur bei einer Hierarchie, die eine App selbst tiefer gebaut
hat, z. B. `<qu-list>`s Leaf-per-Field-Items) bekommt einmalig
`createItem(qubit)` (liefert ein beliebiges opakes "Item", typischerweise
ein bereits eingefügtes DOM-Element) und danach bei jedem Update
`render(item, value, qubit)`. `key(qubit)` bestimmt die Item-Identität
(Default: `qubit.id`). Gleiches `(id, ts)`-Dedup pro Item wie `viewKey()`.

### `bindKey(node, element, { get?, set?, event?, onError? })` → `() => void`
Two-way — derselbe Live-Render wie `viewKey()`, plus ein lokaler
Edit-Listener, der zurückschreibt (`node.put()`). `get`/`set`/`event`
defaulten auf `<input>`/`<textarea>` (`.value`, Event `input`), sonst
`.textContent` (funktioniert für contenteditable).

Beide Hälften des Echo-Problems werden explizit geschützt, nie durch
pauschales Unterdrücken:
- **Schreib-Seite:** ein Edit, dessen Wert bereits dem bekannten lokalen
  Wert entspricht, wird nie geschrieben.
- **Render-Seite:** das QuBit, das dieses Binding selbst gerade geschrieben
  hat, wird nicht erneut gerendert (würde Cursor/Selektion überschreiben)
  — ein ANDERES Binding auf dieselbe `id` (anderer Tab, anderer Nutzer)
  rendert weiterhin normal.

Der `ts` des Writes wird vorab berechnet (`node.runtime.nextTs()`) und mit
eingehenden QuBits verglichen, statt erst nach `await node.put()` — die
Runtime dispatcht synchron während `ingest()`, ein Vergleich erst nach
`await` würde das eigene erste Echo verpassen. `onError(e)` (optional) läuft
bei einem abgelehnten Write (z.B. ACL-Ablehnung); der Element-Wert wird dabei
auf den vorherigen Stand zurückgesetzt.

### `bindObject(node, fields, opts?)` → `() => void`
Two-way, mehrere Felder eines Datensatzes: ein `bindKey()` pro Feld, jedes
Feld eine eigene Leaf-QuBit (`node.get(field)`) — dieselbe "jedes Feld
seine eigene Leaf-QuBit"-Form wie das Profil-Beispiel oben, damit zwei
unabhängige Schreiber nie auf demselben LWW-Register kollidieren.
`fields`: `{ [feldname]: element }`.

```js
import { viewObject, bindKey } from './src/index.js';

const offList = viewObject(qu.own.get('todos'), {
  createItem: (q) => document.querySelector('ul').appendChild(document.createElement('li')),
  render: (li, value) => { li.textContent = value.text; },
});

const input = document.querySelector('#note');
const offBind = bindKey(qu.own.get('note'), input); // tippen schreibt sofort, kein Speichern-Knopf

// beim Unmount:
offList();
offBind();
```

---

## UI-Components-Modul

Deklarative Custom Elements über dem [UI-Bindings-Modul](#ui-bindings-modul)
(`src/ui/components.js`) — `connectedCallback()`/`disconnectedCallback()`
sind das `on()`/`off()`, das Aufrufer von `bindings.js` sonst von Hand
verdrahten müssten. **Browser-only** (erweitert `HTMLElement` beim
Modul-Laden, würde bei einem Node-Import sofort werfen) — bewusst **nicht**
im Barrel `src/index.js`, direkt importieren:
```js
import '../../../src/ui/components.js'; // Seiteneffekt: registriert <qu-view>/<qu-bind>
```

Drei Elemente: `<qu-bind>` ist `<qu-view>` plus Schreiben-zurück, eine
überschriebene Methode statt eines zweiten Mechanismus; `<qu-list>` ist die
deklarative Form von `viewObject()` (siehe unten), gebaut ausschließlich
auf `<qu-view>`/`<qu-bind>` + `QuSpace` — kein vierter Mechanismus. Ein
Datensatz mit mehreren unabhängig schreibbaren Feldern ist N
Geschwister-Elemente mit gleichem `path`-Präfix und je eigenem `key`
(dieselbe Philosophie wie `bindObject()`); für eine SAMMLUNG solcher
Datensätze (Kind-QuBits unter einem Prefix aufzählen) siehe `<qu-list>`.

### `<qu-view path?="..." key?="..." attr?="...">`
One-way.
| Attribut | Pflicht | Beschreibung |
|---|---|---|
| `path` | bedingt | Die QuBit-ID — oder, falls `key` gesetzt ist, das ID-Präfix. Weglassbar, wenn der aktuelle `.qu`-Context selbst eine `.id` hat (ein `QuSpace`) — dann wird dessen eigene Id verwendet, siehe `<qu-list>` |
| `key` | nein | Ergibt `${path}/${key}` als gebundene ID (eigene Leaf-QuBit) statt `path` selbst |
| `attr` | nein | Welches DOM-Attribut/-Property den Wert trägt: `value`, `textContent`, `innerHTML`, `checked` (Schreib-Event `change`), oder ein beliebiges generisches HTML-Attribut (`href`, `src`, `class`, `data-*`, …). Default (`auto`/weggelassen): dieselbe Heuristik wie `bindKey()` selbst — `value` falls vorhanden, sonst `textContent` |

**Zielelement:** ein eingewickeltes einzelnes Kind-Element, falls das
Custom Element genau eines hat, sonst das Element selbst — kein `is="..."`
nötig (fehlt in Safari):
```html
<qu-view path="alice/profile" key="avatar" attr="src"><img></qu-view>
<qu-view path="alice/profile" key="bio"></qu-view> <!-- textContent, Element selbst als Ziel -->
```

### `<qu-bind path="..." key?="..." attr?="...">`
Wie `<qu-view>`, plus Schreiben-zurück (`bindKey()` statt `viewKey()`).
Löst bei einem abgelehnten Write (z.B. ACL-Ablehnung) ein `qu-error`-Event
aus (`detail` = der Fehler, `bubbles: true`) und setzt den Element-Wert auf
den vorherigen Stand zurück.

**Qu-Instanz — nie global:** `.qu` als Property auf dem Element selbst oder
einem Vorfahren (per DOM-Walk gefunden, funktioniert auch über einen
Shadow-Root hinweg via `.host`). Muss gesetzt sein, BEVOR Nachfahren
angehängt werden (`appendChild()` löst `connectedCallback()` synchron aus)
— ein einmaliger Microtask-Retry fängt die "angehängt, `.qu` erst danach
gesetzt"-Reihenfolge ab, bevor endgültig eine Fehlermeldung in die Konsole
geht.

`.qu` muss keine `Qu`-Instanz sein — ein `QuSpace` (`qu.own`/`qu.get(id)`)
funktioniert genauso: `container.qu = alice.own` scoped jeden Nachfahren
relativ zu diesem Space, `path` selbst (falls gesetzt) wird dann noch
EINMAL relativ dazu aufgelöst, nicht absolut.

```js
import '../../../src/ui/components.js';

const container = document.querySelector('#app');
container.qu = qu; // einmal setzen, gilt für alle Nachfahren

container.innerHTML = `
  <qu-view path="${qu.userSpaceId}" key="name"></qu-view>
  <qu-bind path="${qu.userSpaceId}" key="bio"><input></qu-bind>
`;

container.querySelector('qu-bind').addEventListener('qu-error', (e) => console.error(e.detail));
```

### `<qu-list path="...">`
Deklarative Form von [`viewObject()`](#ui-bindings-modul) — ein `<template>`-
Kind, einmal geklont pro Kind-QuBit unter `path`, jeder Klon-Wurzel `.qu`
auf `qu.get(<Item-Id>)` gesetzt, sodass `<qu-view>`/`<qu-bind>` INNERHALB
des Templates ihre Felder mit bloßem `key` adressieren können, ganz ohne
Id-Wiederholung:
```html
<qu-list path="alice/todos">
  <template>
    <li>
      <qu-view key="text"></qu-view>
      <qu-bind key="done" attr="checked"><input type="checkbox"></qu-bind>
    </li>
  </template>
</qu-list>
```
Erkennt ein Item, sobald IRGENDEIN seiner Felder existiert (Pattern
`${path}/**`, Item-Identität = das erste Segment nach `path`) — es ist
KEINE eigene "Wurzel"-QuBit exakt bei `${path}/<itemId>` nötig, nur die
Leaf-Felder selbst.

**Deckt nur den "Datensatz = mehrere Leaf-QuBits"-Fall ab** — denselben,
den `<qu-view key>`/`<qu-bind key>`/`bindObject()` überall sonst auch
voraussetzen. Ein Item, dessen Felder in EINEM kombinierten QuBit-Wert
liegen, oder das eine `key://`/`file://`-Referenz zum Rendern auflösen
muss, hat hier keine rein deklarative Entsprechung — dafür `viewObject()`
direkt nutzen (siehe `docs/lab/labs/05-references-practice.mjs`, das genau
das für sein Kategorie-/Avatar-Feld tut, während sein Notizfeld — eine
eigene Leaf-QuBit — mit `<qu-bind>` auskommt).

Löscht nie Items (dasselbe Verhalten wie `viewObject()`/das gesamte
QuBit-Modell — es gibt kein Lösch-Konzept, nur LWW-Überschreiben). Ein
Remount (`path` geändert, oder das Element neu verbunden) räumt zuvor
gestempelte Items vollständig ab, bevor es neu aufbaut — keine Duplikate.
