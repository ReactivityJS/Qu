# QU — qu-core

Ein kleines, ereignisgetriebenes, Zero-Trust-Framework für lokale und
verteilte Anwendungen. Reines Vanilla JavaScript (ESM), keine
Laufzeit-Abhängigkeiten, läuft in Node ≥ 20 und modernen Browsern
(Web Crypto API, `crypto.randomUUID()`).

Die vollständige Architektur-Spezifikation steht in
[`qu-whitepaper-v0.6.md`](./qu-whitepaper-v0.6.md), die vollständige
Aufrufreferenz jeder Funktion/Klasse in [`API.md`](./API.md) — dieses README
ist der Schnelleinstieg. Eine vernetzte App über einen echten Relay bauen
(mehrere Instanzen, gemeinsamer App-Space): [`APP-GUIDE.md`](./APP-GUIDE.md).

## Installation

Kein Build-Schritt nötig. Innerhalb dieses Repos (oder mit `src/` lokal
vorliegend) einfach importieren:

```js
import { Qu } from './src/index.js';
```

**Als externe Abhängigkeit per `<script type="module">`**, ohne eigenen
Bundler — z. B. für ein separates Projekt, das nur das fertige Framework
braucht: `.github/workflows/build-cdn.yml` baut nach jedem Merge nach
`main` ein einziges gebündeltes `qu[.min].js` (`npm run build`,
`scripts/build.mjs`) und veröffentlicht es auf einem eigenen `dist`-Branch.
Sobald dieses Repo öffentlich ist, ist das direkt über jsDelivrs
GitHub-CDN erreichbar, ganz ohne npm-Veröffentlichung:

```html
<script type="module">
  import { Qu, createNetworkPlugin } from 'https://cdn.jsdelivr.net/gh/reactivityjs/qu@dist/qu.min.js';
  const app = await Qu.create();
</script>
```

`@dist` zieht immer den neuesten `main`-Stand (jsDelivr cached Branches nur
kurz) — für eine dauerhaft stabile, versionierte URL stattdessen auf einen
Release-Tag pinnen, sobald es welche gibt (z. B. `@v0.4.0`).

## Quickstart

Fünf Verben, ein Objekt-Typ — an GunDB angelehnt (`gun.get(key).put(x)`/
`.on(cb)`), aber an QUs signiertem, ACL-geprüftem Schreibmodell:
`get` navigiert (synchron, keine I/O), `put`/`set`/`on`/`map` lesen/
schreiben/beobachten:

```js
const alice = await Qu.create();
alice.own.get('status').on((q) => console.log(q.value));   // live beobachten
await alice.own.get('status').put('online');                // schreiben (LWW)
console.log((await alice.own.get('status')).value);         // 'online' — await liest
```

Ohne jedes Plugin ist nur dein eigener `~<fingerprint>`-Space (`qu.own`)
beschreibbar (`core/identity-acl.js`) — für geteilte, generische Spaces
(Chat-Räume, ToDo-Listen, …) `qu.use(createSpacesPlugin())`.

`Qu` ist die empfohlene Fassade — sie erzeugt (oder importiert) eine
Identität und verdrahtet Runtime/Store/Session im Hintergrund,
sodass man für den Normalfall keine mehreren Bausteine von Hand
zusammensetzen muss. **Der Core selbst ist local-only/offline**: ohne
weiteres Zutun landet alles im `MemoryAdapter`, es wird kein Netzwerk-Code
geladen. Netzwerk (Replication/Transporte/Routing), Storage jenseits von
Memory/Null, und Referenz-/Datei-Handling sind Plugins — angedockt über
`qu.use(...)`, oder gebündelt über ein Preset:

```js
import { Qu, QU_PRESETS, createFileHandlerPlugin, MemoryFileStorageAdapter } from './src/index.js';

const alice = await Qu.create({ plugins: QU_PRESETS.network }); // Spaces + Network in einem
alice.use(createFileHandlerPlugin({ fileStorage: new MemoryFileStorageAdapter() })); // Datei-Auto-Detect für put()
```

Jedes Plugin ist auch ohne `use()` direkt nutzbar — `sendMessage(space, opts)`
aus `modules/chat.js` etwa nimmt einfach einen bereits navigierten Node
entgegen, ganz ohne dass irgendetwas "installiert" wurde; `use()` fügt nur
`qu.sendMessage(spaceId, opts)`-Sugar hinzu, für wer sie will. Siehe
[Core, Storage, Network, Data](#core-storage-network-data--wie-die-plugins-zusammenspielen) unten.

**Nächster Schritt: `examples/`** — vier kurze, fokussierte Module (teilbare
ToDo-Liste, Forum mit Zeit-Sharding, App-Space über einen echten Relay,
mehrere Sub-Spaces indexieren), jedes mit eigenem `node --test` und ohne
Browser lesbar; Übersicht mit Links zum Quelltext unter
[`/docs/examples.html`](http://localhost:8787/docs/examples.html) (`npm
start`). Zum direkten Anfassen im Browser: das [Interaktive
Lab](http://localhost:8787/docs/lab/index.html) (geführt, Schritt für
Schritt) und der
[Playground](http://localhost:8787/docs/playground.html) (eine bereits
initialisierte `qu`-Instanz in der Konsole plus Copy-Paste-Beispiele,
inklusive einer echten Relay-Verbindung). Für Multi-User-Rechte,
Verschlüsselung, Sync und Dateien: siehe [`API.md`](./API.md)
(vollständige Referenz). Die darunterliegenden Bausteine (`QuRuntime`,
`QuSession`, `QuStore`, …) bleiben für fortgeschrittene Fälle direkt
nutzbar — `qu.runtime` ist die Fluchttür dorthin.

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
await alice.own.get('status').put('online'); // eigener Context — geht immer
await alice.get('irgendein/anderer/pfad').put('x'); // ein anderer Context — wirft: [ACL] Write denied
```

**`qu.own`** ist derselbe eigene Context, nur ohne `${alice.userSpaceId}/`
bei jedem Aufruf auszuschreiben — ein `QuSpace`-Node, der jeden Pfad
relativ zu genau diesem Space auflöst. `qu.get(id)` selbst navigiert nur
(synchron, keine I/O); erst `.put()`/`.set()`/`.on()`/`.map()` oder ein
`await` lösen tatsächlich etwas aus:

```js
alice.own.get('status')          // Node, gebunden an `${alice.userSpaceId}/status` — noch keine I/O
console.log((await alice.own.get('status')).value); // 'online' — await liest den aktuellen Wert
```

Um in einem **anderen** Context zu schreiben — einem geteilten Space, oder
dem Space einer anderen Person — muss dieser Context dich explizit als
`writer` listen. Das übernimmt das Spaces-Plugin. `qu.createSpace(opts)`
liefert **synchron** (wie `get()`) direkt einen `QuSpace`-Node für den
neuen Space zurück (statt nur die rohe Id) — Anlegen und erstes Schreiben
laufen über dasselbe Objekt. Synchron ist hier kein Stil-Detail: `QuSpace`
ist thenable (siehe unten), und `await` auf ein `async` `createSpace()`
würde den Node bis zum Manifest-Wert hindurchreichen statt ihn selbst zu
liefern — dieselbe "kein await navigiert, await liest"-Regel wie überall
sonst. Das Manifest wird im Hintergrund geschrieben; `space.ready` ist das
Promise DIESES Writes, falls eine echte Bestätigung gebraucht wird (ein
bloßes `await space` ist nur ein Read und kann dem Write vorauslaufen):

```js
import { createSpacesPlugin } from './src/index.js';

// Für dieses Beispiel teilen sich alice und bob einen Prozess (eine
// Runtime) — der einfachste Fall, um writers/readers zu zeigen, ohne
// gleich Netzwerk/Sync mit hereinzunehmen (das kommt in Abschnitt 3 + 5).
const bob = await Qu.create({ runtime: alice.runtime });
alice.use(createSpacesPlugin());
const room = alice.createSpace({ writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });
await room.ready; // auf das Manifest warten, bevor bob gleich mitschreibt

await room.get('msg1').put('hallo');              // erlaubt, weil room's Manifest alice als writer listet
await bob.get(`${room}/msg2`).put('hi zurück');   // room funktioniert auch weiterhin wie ein roher String — ${room} interpoliert zur Id
```

`qu.createSpace(opts)` erzeugt jedes Mal eine neue, zufällige Id — richtig
für "viele unabhängig angelegte Räume" (ToDo-Listen, Chat-Räume). Für
"genau EIN wohlbekannter Space für diese ganze App" (ein **App-Space**,
siehe [`APP-GUIDE.md`](./APP-GUIDE.md)) `qu.createSpaceAt(id, opts)` —
identisch, nur mit einer selbst gewählten statt einer zufälligen Id. Diese
feste Id ist dann gleichzeitig Adressierung im Code (`qu.get(id)`) UND der
`pushTopics`/`sync({ topic })`-Präfix für den Netzwerk-Abgleich (Abschnitt
3) — es gibt kein separates "Topic"-Konzept in QU, ein Topic ist einfach
ein String-Präfix auf QuBit-Ids, und die robusteste Wahl dafür ist immer
die Space-Id selbst — in echtem Code idealerweise eine einmalig erzeugte
UUID statt eines lesbaren Namens (Kollisionsfreiheit auf geteilter
Infrastruktur), mit einem menschenlesbaren Namen als eigenes Datenfeld
daneben (`space.get('label').put(...)`), nicht als Teil der Id selbst.
Braucht eine App MEHRERE solcher Spaces (mehrere Boards, mehrere
ToDo-Listen), lässt sich das genauso über eine Id-Referenz lösen: ein
Space kann die Id eines anderen ganz gewöhnlich als Feld tragen
(`qu.get(dieseId)` navigiert dorthin, egal woher die Id stammt) — siehe
[`APP-GUIDE.md`, Schritt 8](./APP-GUIDE.md#schritt-8-mehrere-boardstodo-listen-sub-spaces-referenzieren)
und [`examples/space-index-lib.mjs`](./examples/space-index-lib.mjs).

Einen bereits bekannten Space **laden** (statt neu anzulegen) — egal ob
dein eigener, der einer anderen Person (`~<ihr-fingerprint>`), oder ein
geteilter Raum, dessen Id z. B. über einen Link ankam:

```js
const bobsSpace = alice.get(bob.userSpaceId);   // ~<bob-fp> — liest, was bob öffentlich freigegeben hat
const sameRoomAgain = bob.get(room.id);          // dieselbe room-Id, jetzt aus bobs Sicht
```

`qu.get(id)` selbst prüft nichts — es baut nur den Node. Jeder tatsächliche
`put`/`set`/`on`/`map`/`await`-Aufruf darüber wird exakt so ACL-geprüft,
wie derselbe Aufruf mit dem vollen Pfad direkt auf `qu` es auch wäre;
`qu.own` ist nichts als `qu.get(qu.userSpaceId)`.

**`put(value)` und `set(value)` sind zwei grundlegend verschiedene Formen:**
`put(value)` ist EIN benannter, veränderlicher Wert — der Node selbst
trägt ihn, `await node` liest ihn, ein zweiter `put()` überschreibt ihn
(nichts akkumuliert). `set(value)` ist ARRAY-artig — der Node selbst wird
NIE beschrieben (`await node` bleibt `null`), stattdessen legt jeder
`set()`-Aufruf ein neues, eigenes Kind an (`${fingerprint}-${ts}` als ein
Pfadsegment, kollisionssicher über mehrere unabhängige Schreiber hinweg,
genauso eine Ebene tief wie eine `put()`-basierte Sammlung). Die wachsende
Liste selbst liest man nie über den Node direkt, sondern über
`node.map(cb)`/`session.query()`:

```js
await room.get('msgs').set({ text: 'erste Nachricht' });  // landet unter room/msgs/<alice-fp>-<ts>
await bob.get(`${room}/msgs`).set({ text: 'zweite Nachricht' }); // eigener Namensraum, keine Kollision möglich
console.log(await room.get('msgs'));                       // null — an msgs selbst wurde nie put()-geschrieben
const all = await room.session.query(`${room}/msgs/**`);   // so liest man die Liste: alle Einträge, wie ein Array
```

**Verschlüsselung ist der Default, sobald ein Space nicht öffentlich lesbar
ist.** Setzt du `readers` auf eine konkrete Liste statt `['*']` (wie oben
bei `room`, falls dessen Manifest das so anlegt), verschlüsselt jedes
`put()`/`set()` in diesem Space automatisch für genau diese Leser — ganz
ohne `encryptFor` selbst angeben zu müssen. Voraussetzung: jedes Mitglied
veröffentlicht einmal sein eigenes Profil, damit die anderen seinen
Verschlüsselungs-Key finden:

```js
await alice.publishProfile({ alias: 'Alice' }); // einmalig — jedes Mitglied für sich
await bob.publishProfile({ alias: 'Bob' });

await room.get('msgs').set({ text: 'geheim' }); // automatisch für alle `room`-Leser verschlüsselt
```

Explizit im Klartext bleiben (auch in einem eingeschränkten Space):
`opts.encryptFor = null`. Details, inklusive was strukturell nie verschlüsselt
wird (das Space-Manifest selbst, die drei reservierten Profil-Felder), stehen
in [API.md](./API.md#sessionpublishid-value-opts).

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

**Ein App-unabhängiger Relay: `allowDynamicSubscribe`.** Das `pushTopics`
oben ist Deployment-Konfiguration — feste Präfixe, die beim Start des
Relay-Prozesses feststehen. Das passt nicht, wenn Spaces erst zur Laufzeit
entstehen (z. B. `qu.createSpace()` mit einer zufälligen Id) und der Relay
trotzdem nichts von einer konkreten App wissen soll. Für genau diesen Fall
kann ein LESENDER Client sein Topic-Interesse selbst, zur Laufzeit,
anmelden:

```js
// Relay: läuft komplett "ungebunden", kennt keine App-spezifischen Topics
const relayApi = await createRelay({ allowDynamicSubscribe: true });

// Schreibende Seite: pusht alles, was sie selbst schreibt — eine bereits
// vorher bestehende, rein client-seitige Option (kein Teil dieser neuen
// Funktion), hier aber die naheliegende Wahl, weil die Space-Id vorher
// nicht feststeht:
const replAlice = await alice.connect(channelAlice, { pushTopics: [''] });

// Lesende Seite: meldet ein Topic erst an, wenn sie es wirklich braucht
const repl = await bob.connect(channelBob, { pushTopics: [] });
await repl.ensureSynced(spaceId); // holt lokal fehlenden Stand (sync) UND meldet Live-Interesse an (subscribe) — ein Aufruf für beides
```

`allowDynamicSubscribe` macht ausschließlich die LESE-Seite dynamisch — ob
und was ein Relay an eine bestimmte Verbindung weiterleitet. Was ein
Client selbst zum Relay hin PUSHT, bestimmt weiterhin ausschließlich sein
eigenes `pushTopics` bei `connect()`, komplett unverändert. `pushTopics:
['']` ("push alles, was ich selbst schreibe") ist dafür keine neue
Funktion, sondern dieselbe Option, die es schon vor `allowDynamicSubscribe`
gab — hier nur die passende Wahl für eine zur Laufzeit erzeugte Id, die
beim Verbinden noch nicht feststeht. Die ACL entscheidet am Ende trotzdem
für jeden Leser einzeln, was tatsächlich ankommt — ein breites `pushTopics`
beim Schreiber bedeutet nur "der Relay bekommt es zu sehen", nicht "jeder
Client bekommt es zugestellt".

`ensureSynced(topic, opts?)` ist die "hole lokal, frage remote nach, und
abonniere live" Kurzform — intern nur `await this.sync({ topic, ...opts });
await this.subscribe(topic);`. Genau das passiert automatisch, sobald ein
`node.on(cb)`/`node.map(cb)` aktiviert wird und ein Network-Plugin
installiert ist — **ein einziges Mal beim Aktivieren des Listeners**, nicht
pro Event (dieselbe Zeitpunkt-Entscheidung wie bei der `key://`-Auflösung
oben): jeder verbundene Peer wird gebeten, den aufgelösten Pfad ab jetzt zu
pushen. `qu.get(id)` bzw. `await qu.get(id)` triggert das **nicht** — erst
ein tatsächlicher Listener (`on`/`map`) braucht wirklich laufende
Zustellung; `{ raw: true }` schaltet es ab (wie beim `key://`-Following).

`allowDynamicSubscribe` ist eine reine Sicherheitsgrenze auf der
EMPFANGENDEN Seite eines `qu.subscribe`-Wunsches — sie erlaubt nie mehr, als
die ACL ohnehin schon zulässt (jeder Push läuft weiterhin durch
`filterForReader`, siehe API.md), sie entscheidet nur, ob eine Anfrage
überhaupt eine Chance bekommt, gegen die ACL geprüft zu werden:
- `false` (Default) — ein `qu.subscribe`-Wunsch wird stillschweigend
  ignoriert, exakt das bisherige Verhalten ohne diese Funktion.
- `true` — jedes angefragte Topic wird angenommen (weiterhin ACL-geprüft
  vor jeder tatsächlichen Zustellung) — der "ungebundene Relay"-Fall oben.
- `string[]` — eine harte Obergrenze: ein Topic wird nur angenommen, wenn es
  mit einem der Einträge beginnt (`topic.startsWith(präfix)`) — "privater
  App-Server, beschränkt auf bestimmte App-Space-Ids" (**Ids, keine
  lesbaren Namen** — siehe Schritt 3 der App-Guide):
  ```js
  await createRelay({ allowDynamicSubscribe: ['3fa85f64-…/', 'a1b2c3d4-…/'] });
  ```

`maxDynamicTopics` (Default `200`, pro Verbindung) begrenzt zusätzlich, wie
viele NEUE Topics eine einzelne Verbindung zur Laufzeit anmelden darf —
bereits über `pushTopics` aktive Topics zählen nicht mit. Schutz gegen eine
einzelne Verbindung, die den Relay mit beliebig vielen `qu.subscribe`-
Anfragen flutet, unabhängig von `allowDynamicSubscribe`s eigener Grenze.

`qu.connect()`s `subscribeOwnSpace` (Default `true`) nutzt denselben
Mechanismus automatisch für den eigenen Space: nach dem Verbinden fragt es
den Peer, `qu.userSpaceId` zurückzupushen — "zumindest den eigenen Space
über Geräte hinweg synchron halten", ohne jede Extra-Konfiguration (z. B.
falls der Relay Änderungen von einem anderen Gerät bereits gespeichert
hat). `false` schaltet das ab (z. B. eine bewusst anonyme/asymmetrische
Verbindung ohne eigenen Space). **Wichtig, leicht zu verwechseln:**
`subscribeOwnSpace` betrifft nur die EMPFANGENDE Richtung — was diese
Verbindung selbst nach außen pusht, bestimmt weiterhin ausschließlich das
eigene `pushTopics` bei `connect()`, komplett unverändert und unabhängig
von `subscribeOwnSpace`.

### 4. Arten von Events

Diese Matrix ist eine der zentralen Kernideen von QU, nicht nur eine
Konfigurationsoption unter vielen: **jedes** `put()`/`set()` ist ein
Event, und genau zwei unabhängige Dimensionen legen vollständig fest, was
mit ihm passiert — es gibt keine dritte, versteckte Form. Ein "Event" in QU
ist schlicht ein QuBit, das über `on()`/`map()` zugestellt wird:

**Ort — lokal oder remote-shared:**
- **Lokal**: kein Network-Plugin installiert/verbunden — `put()`/`set()` bleibt auf diesem Prozess/Tab.
- **Remote-shared**: `createNetworkPlugin()` + `qu.connect()` — derselbe `put()`/`on()`-Code, jetzt zusätzlich über `pushTopics` an verbundene Peers weitergereicht (Abschnitt 3).

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
haben wollen, ohne eine separate `use()`-Kette zu schreiben. `src/presets.js`
bündelt gängige Kombinationen als `QU_PRESETS`:

```js
import { Qu, QU_PRESETS, createFileHandlerPlugin, MemoryFileStorageAdapter } from './src/index.js';

const qu = await Qu.create({
  plugins: [...QU_PRESETS.spaces, createFileHandlerPlugin({ fileStorage: new MemoryFileStorageAdapter() })],
});
// oder direkt eines der drei fertigen Presets:
//   QU_PRESETS.local   — [] (Core-Default, nur zur Symmetrie benannt)
//   QU_PRESETS.spaces  — [createSpacesPlugin()]
//   QU_PRESETS.network — [createSpacesPlugin(), createNetworkPlugin()]
```
Beide Optionen sind rein additiv — `Qu.create()` ganz ohne sie verhält sich
exakt wie bisher, komplett lokal, keine Plugins geladen.

**Live beobachten:** `node.on(callback, { initial?, once? })` (dieser eine
Node) bzw. `node.map(callback, { deep?, initial?, once? })` (seine Kinder —
`set()`-Sammlungen sind genauso eine Ebene tief wie `put()`-Sammlungen,
`deep: true` braucht es nur für eine Hierarchie, die eine App selbst tiefer
gebaut hat, z. B. Leaf-per-Field-Items) — `initial: true` (bei `map()` der
Default) liefert erst alles bereits Passende, danach laufend Neues;
`once: true` liefert nur den aktuellen Stand, keine laufende Subscription.

### 5. Trigger & Listen: Events auslösen und darauf reagieren

Die Kombinationen aus Abschnitt 4 an einem durchgehenden Beispiel — derselbe
`on()`/`put()`-Code für jede:

```js
// Lokal + Memory (Standard)
const qu = await Qu.create();
qu.own.get('counter').on((q) => console.log('lokal:', q.value));
await qu.own.get('counter').put(1);

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

bobRemote.get(`${alice.userSpaceId}/msg`).on((q) => console.log('bei bob angekommen:', q.value)); // Listener zuerst registrieren
await alice.get(`${alice.userSpaceId}/msg`).put('hallo bob');                                     // kommt live bei bob an, ganz ohne dass bob je gefragt hat
```

### 6. QuStore als verteilte, geteilte DB

Mit den obigen Bausteinen zusammengesetzt ergibt sich ein Bild, das über
"Event-System" hinausgeht: QU ist eine **reaktive, verteilte Datenbank**,
bei der jede klassische DB-Frage eine direkte Entsprechung hat:

| Klassische DB-Frage | QU-Antwort |
|---|---|
| Was ist eine Zeile? | Ein QuBit (`{id, value, ts, writer, sig}`) — `put()` = LWW-Register, `set()` = kollisionsfreier Sammlungs-Eintrag |
| Wie stelle ich eine Anfrage? | `node.map(cb, {once:true})` — einmalig; `node.map(cb, {initial:true})` (Default) — dieselbe Anfrage, dauerhaft live |
| Welche Storage-Engine? | Austauschbarer `StorageAdapter` — Memory/Session/Local/IndexedDB/Filesystem, identische API (Abschnitt 4) |
| Wie repliziere ich zu einer entfernten Kopie? | `qu.connect()` + `pushTopics`/`role: 'mirror'` — derselbe Space, gespiegelt auf einen Relay-Prozess (Abschnitt 3) |
| Wie sind Rechte modelliert? | Pro Space (nicht pro Tabelle/Zeile): ein Manifest mit `writers`/`readers`/`admins`, write-seitig als Middleware erzwungen (`runtime.ingest()`), read-seitig gefiltert (`filterForReader()`) |
| Wie adressiere ich relativ statt jedes Mal den vollen Pfad? | `QuSpace` (`qu.own`, `qu.get(id)`, `qu.createSpace()`) — ein Node, an einen Space gebunden, `put`/`set`/`on`/`map` relativ dazu, gleichzeitig thenable (`await node` liest) (Abschnitt 2) |
| Ordering-Garantie? | Hybrid-Logical-Clock (`runtime.nextTs()`) statt Wall-Clock — konsistente Ordering-Entscheidungen auch über mehrere Schreiber/Geräte hinweg. Ein exaktes `ts`-Gleichstand (zwei unabhängige Geräte, seltener Zufall) wird deterministisch über `writer` aufgelöst (`compareQubits()`, `core/store.js`) — jedes Replikat kommt unabhängig vom Ankunftszeitpunkt zum selben Ergebnis |

Ein Client, der lokal schreibt, ein Relay mit durablem Storage, und beliebig
viele weitere Clients, die sich über `sync()`/Live-Push denselben Space
teilen, bilden zusammen genau das: eine eventually-consistent, geteilte
Datenbank, bei der "eine Query stellen" und "auf Änderungen lauschen"
dieselbe Operation sind (`map()`), nicht zwei getrennte APIs.

### 7. Datenstruktur für wachsende Collections (z. B. ein Forum)

`node.map(cb)` liefert IMMER die komplette Treffermenge — es gibt (bewusst,
siehe Abschnitt 6) kein Limit/Offset im Core. Für eine Collection, die
strukturell nur eine überschaubare Größe erreichen kann (z. B. die Liste der
Boards eines Forums), ist das genau richtig. Für eine Collection, die
UNBEGRENZT wächst (die Posts *innerhalb* eines aktiven Boards), ist
`board.get('posts').map(cb)` ein Problem, das mit der Zeit nur schlimmer
wird — Board-weise splitten reicht allein nicht,
weil das nur die Anzahl der Boards begrenzt, nicht die Anzahl der Posts in
einem einzelnen (populären) Board.

**Die Regel: nie `map()` auf eine strukturell unbegrenzte Ebene
anwenden — die ID-Struktur so wählen, dass jede Ebene, die tatsächlich
abonniert wird, von Natur aus begrenzt ist.** Der Standard-Trick dafür ist
Zeit-Sharding: Posts nicht flach unter `posts/<postId>` ablegen, sondern
zusätzlich nach einem Zeit-Bucket gruppiert. Ein Client abonniert dann nie
"alle Posts, für immer", sondern gezielt den aktuellen Bucket:

```js
const board = qu.get(`forum/${boardId}`);
const currentBucket = new Date().toISOString().slice(0, 7); // "2026-07"
board.get('posts').get(currentBucket).map(renderPost); // nur dieser Monat
```

**Zwei gleichwertige Modelle, je nach erwarteter Datenmenge:**

| Modell | Beispiel-Id | Wann |
|---|---|---|
| Ein Segment (Bucket als String) | `posts/2026-07/<postId>` | Standardfall — Granularität (Jahr/Monat/Woche/Tag) ist frei wählbar PRO Collection, ohne die Pfadtiefe zu ändern |
| Mehrere Segmente (ein Level pro Kalendereinheit) | `posts/2026/07/12/<postId>` | Wenn quer über Zeiträume mit `*` gefiltert werden soll (z. B. "jeder Juli, alle Jahre": `posts/*/07/*`) |

**Wichtige Regel, unabhängig vom gewählten Modell: die Anzahl der
Datums-Segmente muss innerhalb EINER Collection immer identisch sein** —
nicht `posts/2026-07/x` neben `posts/2026/07/x` im selben Board mischen.
Sonst passt kein `*`/`**`-Pattern mehr konsistent auf die ganze Collection,
und der Bucket-Index (unten) kann Buckets nicht mehr eindeutig sortieren.
Beide Modelle — ein Segment, mehrere Segmente, oder auch gar kein
Zeit-Segment (für strukturell kleine Collections wie die Boardliste selbst)
— sind gültig; welches passt, hängt von App und erwarteter Datenmenge ab.

ISO-Format (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`) hat einen konkreten Vorteil
gegenüber jedem anderen Format: lexikographische String-Sortierung ist
gleichzeitig chronologische Sortierung (`"2026-07" < "2026-08"`) — nützlich
für den Bucket-Index unten, ganz ohne Datums-Parsing.

**`*` matcht genau ein Segment, überall — auch mittig, ohne Sonderfall:**
`posts/*/07/*` (jeder Juli, jedes Jahr, jeder Tag) funktioniert exakt wie
erwartet. **`**` dagegen ist nur als LETZTES Segment eines Patterns gültig**
(`assertValidPattern()`, `core/pattern.js`, wird von `query()` UND
`on()`/`map()` durchgesetzt) — ein Pattern wie `posts/**/01` wirft jetzt
einen klaren Fehler, statt bei `query()` korrekt zu filtern, aber bei einer
laufenden `on()`/`map()`-Subscription still ALLES unter `posts/` zu liefern
(ein vorher existierender, stiller Split-Brain-Bug zwischen den beiden
Matching-Engines).

**"Ältere laden" ohne Pagination-Primitiv im Core:** ein kleiner, expliziter
Bucket-Index reicht — beim ersten Post eines neuen Buckets mitschreiben:
```js
// Bei jedem ersten Post eines neuen Buckets:
await board.get('bucket-index').set({ bucket: currentBucket });

// "Ältere laden": Index einmalig lesen, nächstälteren Bucket gezielt nachladen
const rows = await board.get('bucket-index').session.query(`${board.id}/bucket-index/**`);
const buckets = [...new Set(rows.map((q) => q.value.bucket))].sort();
const older = buckets[buckets.indexOf(currentBucket) - 1];
if (older) board.get('posts').get(older).map(renderPost, { once: true });
```
"Eine Seite laden" wird so zu "einen Bucket laden" — Pagination als
Datenmodell-Muster statt als Core-Feature.

**Bonus: dasselbe Muster begrenzt auch Netzwerk-Traffic.** `pushTopics`/
`sync({ topic })` sind präfixbasiert (Abschnitt 3) — mit Zeit-Buckets kann
das Sync-Topic `forum/board1/posts/2026-07/` sein, sodass auch über das
Netz nur der aktuelle Monat übertragen wird, nicht das ganze Board.

**Für "neueste Posts über alle Boards" (Startseite):** Zeit-Sharding allein
hilft hier nicht (Cross-Board-Aggregation). Dafür eine bewusst
denormalisierte, gedeckelte Index-Collection (`forum/recent-index/<postId>`),
beim Schreiben eines Posts zusätzlich dort eingetragen und von der App auf
z. B. die letzten 100 Einträge begrenzt gehalten — der ursprüngliche Post
bleibt unverändert bestehen (Immutable Data), nur der Index "vergisst"
ältere Einträge. Die Startseite abonniert nur diesen kleinen Index, nie
`forum/*/posts/**`.

**Lauffähiges Beispiel:** [`examples/forum-lib.mjs`](./examples/forum-lib.mjs)
setzt genau dieses Muster (ein Segment, `YYYY-MM`) vollständig um —
`createBoard`, `addPost`, `listPosts`, `onPosts`, `listBuckets`,
`olderBucket` — inklusive Bucket-Index und kollisionssicherem gleichzeitigem
Schreiben mehrerer Autoren; [`examples/forum-lib.test.mjs`](./examples/forum-lib.test.mjs)
zeigt jede Garantie (Bucket-Isolation live wie beim Lesen, Dedup/Sortierung
des Index, keine Kollision) als laufenden Test.

### 8. Referenzen automatisch folgen (`key://`)

Mit [`createReferenceHandlerPlugin()`](./API.md#references-modul) installiert
folgen `await`/`.put()`/`.set()`/`.on()`/`.map()` einer `key://`-Referenz
(siehe References-Modul) transparent, statt den rohen String
zurückzugeben — für den häufigsten Fall "diese Id ist eigentlich nur ein
Alias auf einen anderen Space/Wert":

```js
import { Qu, createSpacesPlugin, createReferenceHandlerPlugin, keyRef } from './src/index.js';

const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
const board = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
await board.ready;

await alice.own.get('currentBoard').put(keyRef(board.id)); // ein Alias, kein Duplikat

const resolved = await alice.own.get('currentBoard'); // liest transparent DURCH die Referenz
console.log(resolved.value);       // der Wert AN board.id, nicht der "key://…"-String
console.log(resolved.id);          // board.id — die ECHTE Adresse, nicht der Alias-Pfad

// weiter navigieren: die aufgelöste Id einfach übernehmen
const sameBoard = alice.get(resolved.id);
```

**Kostenlos für den referenzfreien Normalfall:** geprüft wird nur der Wert
AN der Id, die ein Verb tatsächlich aufruft — kein zusätzlicher Read
gegenüber heute, weil dieser Wert ohnehin gelesen werden musste, um ihn
zurückzugeben. Ohne `createReferenceHandlerPlugin()` bleibt das Verhalten
exakt wie vorher (Core kennt `key://` nicht, `resolveDispatch` ist die
Identitätsfunktion).

**Vier Fallstricke, die die Doku statt eine Ausnahme im Code löst:**

1. **Kein Mid-Path-Auflösen.** `node.get(subpath)` bleibt reine, synchrone
   Pfad-Konkatenation — es prüft nie, ob ein bereits gebautes Zwischenstück
   des Pfads selbst eine Referenz ist. Aufgelöst wird nur die Id, auf der
   ein Verb (`await`/`put`/`set`/`on`/`map`) tatsächlich aufgerufen wird:
   ```js
   await appSpace.get('currentBoard').get('posts').set({...}); // KEINE Auflösung — 'posts' wird
                                                                   // wörtlich an den Alias-Pfad gehängt
   const board = alice.get((await appSpace.get('currentBoard')).id); // EIN expliziter Schritt …
   await board.get('posts').set({...});                              // … dann normal weiterarbeiten
   ```
   Das ist kein Bug, sondern der Normalfall: "durch Referenzen navigieren"
   ist ein Helfer für den EINEN Auflösungs-Schritt, nicht dafür gedacht,
   dass man nie mehr merkt, wo man gerade ist. Der empfohlene App-Aufbau
   bleibt: erst auflösen (`app -> boards -> myBoard`), danach ganz normal
   im Ziel-Space weiterarbeiten (siehe [Schritt 8 im APP-GUIDE.md](./APP-GUIDE.md#schritt-8-mehrere-boardstodo-listen-sub-spaces-referenzieren)).
   Dieselbe Eigenschaft ist auch ein Sicherheitsnetz: ein unaufgelöster
   Mid-Path-Schreibvorgang landet strukturell dort, wo `.get()` ihn baut —
   nie versehentlich in einem fremden, referenzierten Space.
2. **Nur `key://` folgt automatisch.** `obj://` (eine Sammlung) und
   `file://` (Bytes) werden bewusst NICHT automatisch aufgelöst — ihr
   Ergebnis ist strukturell etwas anderes als "ein Wert an einer Id"
   (ein Array/Objekt bzw. rohe Bytes), das würde den Rückgabetyp von
   `await node` unvorhersagbar machen. Dafür weiterhin explizit
   `resolveReference()`/`resolveFileRef()` (References-Modul).
3. **`on()`/`.map()` lösen genau EINMAL auf, beim Aktivieren — nie pro
   Event.** Zeigt eine Referenz später auf ein anderes Ziel um, folgt eine
   bereits laufende Subscription NICHT automatisch nach (Abmelden +
   neu Abonnieren, falls gewünscht). `on()` ohne `{ raw: true }` ist
   dadurch nicht mehr rein synchron/lückenlos wie zuvor (ein einmaliger,
   kurzer Setup-Schritt läuft vorher) — `{ raw: true }` stellt das alte,
   exakt synchrone Verhalten wieder her.
4. **`{ raw: true }`** (bei `put`/`set`/`on`/`map`) schreibt/liest an der
   wörtlichen Id, ohne Auflösung — Escape-Hatch für den seltenen Fall, den
   rohen `key://…`-String selbst sehen/schreiben zu wollen. Für `await
   node` (keine Options-Parameter, das Thenable-Protokoll) ist die
   Entsprechung `await node.session.get(node.id)`.

**ACL folgt immer dem ZIEL-Space, nicht dem Alias-Besitzer** — verifiziert:
jeder darf sich einen eigenen Alias auf einen fremden, restriktiven Space
anlegen (der Alias selbst ist nur eine Referenz unter dem eigenen, immer
beschreibbaren Space), aber ein Schreibversuch DURCH den Alias wird exakt
so geprüft, als hätte man die Ziel-Id direkt angesprochen — kein
Sonderfall im ACL-Code, das folgt automatisch daraus, dass die aufgelöste
Id am Ende ein ganz normaler, unveränderter Aufruf ist.

## Projektstruktur

```
index.js                ← Server-Bootstrap (verdrahtet server/static-server.mjs, server/test-runner.mjs
                          und den Relay — kein QU-Datenmodell-Code selbst)
index.html                ← Navigation zu Demo/Tests/Whitepaper/README/API (ebenfalls kein QU-Code)
API.md                     vollständige Aufrufreferenz (Parameter, Rückgabewerte, Beispiele)
server/static-server.mjs   generischer statischer Dateiserver (optionaler `routes`-Parameter als
                          QU-agnostische Erweiterungsstelle, siehe server/test-runner.mjs)
server/test-runner.mjs      /test/manifest.json (selbst-scannende Browser-vs-Node-Klassifizierung)
                          + /test/run-node-tests (opt-in, siehe Abschnitt "Tests" unten)
scripts/run-node-only.mjs   node:test-Runner für die Node-only-Dateien, als isolierter Kindprozess
                          von server/test-runner.mjs aufgerufen; bewusst außerhalb test/, weil
                          Node's `--test`-Discovery sonst diese Datei selbst als Testdatei anfasst
assets/style.css            gemeinsames Stylesheet für alle Tooling-Seiten
docs/view.html                generischer Markdown-Viewer (Whitepaper, README, API.md)
src/
  index.js              ← einziger öffentlicher Einstiegspunkt der Bibliothek
                          (Core + Memory/Null-Adapter + alle Plugin-Factories —
                          kein node:fs, kein Browser-only-Code zwingend geladen)
  qu.js                   Qu — schlanke Fassade: Identity/Session/qu.get(id)
                          (liefert einen QuSpace-Node — get/put/set/on/map,
                          gleichzeitig thenable), qu.own, generisches
                          qu.use(plugin), qu.setACLResolver()/setPutHandler()
                          (die Erweiterungspunkte, die createSpacesPlugin()
                          bzw. createFileHandlerPlugin() nutzen),
                          Qu.create({ mounts?, plugins? }) als Sugar für einen
                          eigenen QuStore bzw. eine use()-Kette
  presets.js                QU_PRESETS (local/spaces/network) — fertige
                          plugins-Listen für Qu.create({ plugins }); liegt
                          bewusst außerhalb core/ (importiert aus modules/
                          und network/, was qu.js selbst nie darf)
  core/                  lokal, offline-sicher, keine Netzwerk-/Storage-Vendor-
                          Abhängigkeit: Pipeline, Runtime, Store (Adapter-Mounts),
                          Session, Identity, Space-Handle (QuSpace — an einen
                          Space gebundenes get/put/set/on/map, reine
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
                          rate-limiter.js (Relay-Schutz gegen einen
                          flutenden Peer), ingest-gate.js (die Middleware-
                          Pipeline für eingehende Pushes — requireDirectWriter/
                          rateLimiter sind Kurzformen für die beiden
                          eingebauten Gates hier drin, siehe oben), index.js
                          (createNetworkPlugin — qu.connect()/qu.router-Sugar),
                          webrtc-plugin.js (createWebRTCPlugin —
                          qu.webrtc()-Sugar, bewusst eigenes Plugin statt Teil
                          von createNetworkPlugin, siehe Bundle-Größe)
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
                          Space ist beschreibbar. qu.createSpace() ist
                          synchron (liefert den Node sofort, wie get()) —
                          das Manifest wird im Hintergrund geschrieben,
                          space.ready ist dessen eigenes Promise
    chat.js                  Räume, Nachrichten, Anhänge, Presence, Lesebestätigungen
                          — jede Funktion nimmt einen bereits navigierten
                          Space-Node entgegen und ist intern nur eine kurze
                          get/put/set/map-Kombination; createChatPlugin
                          hängt qu.sendMessage(spaceId, opts)-Sugar (etc.) an
  ui/
    bindings.js               viewKey/viewObject (one-way) + bindKey/bindObject
                          (two-way) — die reaktiven UI-Primitive, auf denen
                          jede Lab-Ansicht aufbaut: nichts als node.on()/
                          node.map() + Render-Callback, unmount = off().
                          Nehmen einen bereits navigierten Node entgegen
                          (`viewKey(qu.get(id), render)`), kein (qu, id)-Paar
                          mehr. DOM-Library-agnostisch (kein document.* hier
                          drin, Callers liefern die Element-Glue). Echo-Schutz
                          beim Two-Way-Binding: Schreiben unterbleibt bei
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
                          `qu.get(<Item-Id>)` gesetzt, sodass `<qu-view
                          key>`/`<qu-bind key>` im Template ihre Felder ohne
                          Id-Wiederholung adressieren; deckt nur den
                          Leaf-per-Field-Fall ab (siehe API.md). Qu-Instanz
                          nie global: `.qu` als Property auf dem Element
                          oder einem Vorfahren, per DOM-Walk gefunden — auch
                          ein QuSpace (`qu.own`/`qu.get(id)`), nicht nur
                          eine Qu-Instanz. Bewusst BROWSER-ONLY (erweitert
                          HTMLElement beim Modul-Laden), deshalb nicht im
                          Barrel `src/index.js`, direkt importieren.
test/
  qu.test.mjs               Tests für die Qu-Fassade
  space-handle.test.mjs         Tests für QuSpace (qu.own/qu.get()/createSpace()) und Qu.create({ mounts, plugins })
  chat.test.mjs               Tests für das Chat-Modul (inkl. Kollisionssicherheit, Presence, Lesebestätigungen)
  relay.test.mjs               End-to-End gegen den echten WebSocket-Relay (native WebSocket-Clients, kein Loopback)
  references.test.mjs            obj://, key://, file://, Tiefenlimit, Zyklenschutz
  *.test.mjs                node:test — je Datei ein weiterer Themenbereich
  browser-shim/             node:test/node:assert-Ersatz für den Browser
  index.html                 vereinheitlichtes Test-Dashboard: browser-taugliche Dateien laufen
                            direkt hier (via Import-Map), Node-only-Dateien optional serverseitig
                            über server/test-runner.mjs — ein Ergebnis, eine Übersicht
docs/lab/                    interaktives Lab — der primäre Weg, QU im Browser
                            selbst auszuprobieren (siehe eigener Abschnitt unten)
  index.html                 Navigation + fünf Abschnitte, je ein "Ausführen"-Button
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
examples/                    Übersicht mit Quelltext-Links: /docs/examples.html (npm start)
  todo-lib.mjs               Logik einer teilbaren ToDo-Liste, getrennt von jeder UI
  todo-lib.test.mjs            node:test dafür — Space + Link + FP-basiertes Schreibrecht
  forum-lib.mjs               Zeit-Sharding für wachsende Collections (Grundkonzepte, Abschnitt 7)
                            lauffähig statt nur Prosa: Boards, Posts pro Zeit-Bucket, Bucket-Index
  forum-lib.test.mjs           node:test dafür — Bucket-Isolation (live wie beim Lesen),
                            Index-Dedup/-Sortierung, kollisionssicheres gleichzeitiges Schreiben
  relay-space-demo-lib.mjs             App-Space über einen echten WebSocket-Relay — offene vs.
                            mitgliederbeschränkte Variante (App-Guide baut hierauf auf)
  relay-space-demo-lib.test.mjs          node:test dafür — läuft gegen einen echten, im Test selbst
                            gestarteten Relay-Prozess, kein Mock
  space-index-lib.mjs           mehrere Sub-Spaces von einem App-Space aus referenzieren/
                            indexieren ("App hat viele Spaces" statt "App ist ein Space")
  space-index-lib.test.mjs        node:test dafür
docs/playground.html         eine bereits initialisierte qu-Instanz in der Konsole + Copy-Paste-
                            Beispiele (get/put/set/on/map, Spaces, Referenzen, Dateien, Relay)
docs/examples.html            Kartenübersicht über examples/ mit Links zum Quelltext (docs/code.html)
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
`qu.get(id)` (`put`/`set`/`on`/`map`, thenable für lesenden `await`) — alles
auf dem `MemoryAdapter`, kein `node:fs`-Import, kein `WebSocket`/
`RTCPeerConnection` je referenziert. Das ist mit einem einzigen Test
abgesichert (`grep` auf `src/index.js` findet keinen Netzwerk-/Node-Import)
und mit einem End-to-End-Smoke-Test (`Qu.create()` → `get().put()`/`await
get()` → funktioniert, ganz ohne Plugin).

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
   und WebRTC), Handshake, WebSocket-Transport. `qu.use(createNetworkPlugin())`
   fügt `qu.connect()`/`qu.router` hinzu — vorher existieren diese Methoden
   schlicht nicht auf der Qu-Instanz. Node Relay/Router/StorageMirror
   (`relay/`) sind Deployments *dieser* Kategorie, kein Sonderbau:
   `Router{role:'mirror'}` + ein durables `StorageAdapter` +
   `relay/relay.mjs` ergeben zusammen einen StorageMirror. **WebRTC ist ein
   eigenes, drittes Plugin** (`createWebRTCPlugin()`, fügt `qu.webrtc()`
   hinzu, braucht `createNetworkPlugin()` bereits installiert) — bewusst
   nicht Teil von `createNetworkPlugin()` selbst, siehe
   [Bundle-Größe](#bundle-größe) unten.
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
     automatischer Read-Hook in `get()`, gleiche Philosophie: der Core
     bleibt ein dummer Store, die App entscheidet, wann sie einem Link
     folgt. `maxDepth` (Default 1) begrenzt, wie viele Referenz-Hops
     kaskadiert werden — inklusive Zyklenschutz (ein Ref, der auf sich
     selbst zurückführt, bleibt ab dem zweiten Auftreten im selben Pfad
     unaufgelöst statt zu hängen).
   - **Referenzen schreibt man immer explizit** — nichts davon passiert
     beim Schreiben automatisch: `put(bytes)` mit konfiguriertem
     `FileHandler` chunked+manifestiert automatisch, aber das Einbetten des
     zurückgegebenen `file://`-Strings woanders (z. B. in eine
     Chat-Nachricht) ist ein eigener, expliziter Schritt der App
     (`sendMessage()`s `refs`-Parameter, Chat-Modul); `set()`-Sammlungen
     sind einfach viele eigene QuBits, `obj://<pfad>` muss explizit
     aufgerufen werden, um sie zu einer Liste zusammenzufassen. Eine
     Referenz AUF EINEN SPACE selbst schreibt man genauso explizit:
     `node.put(keyRef(otherSpace.id))` — **nicht**
     `node.put(otherSpace)` (die `QuSpace`-Instanz direkt als Wert wirft
     jetzt einen klaren Fehler, siehe [References-Modul](./API.md#references-modul)).
   - **Beim LESEN/SCHREIBEN/ABONNIEREN folgt `key://` dagegen automatisch**,
     sobald `createReferenceHandlerPlugin()` installiert ist —
     `put`/`set`/`on`/`map`/`await` lösen eine `key://`-Referenz AN der Id,
     auf der sie aufgerufen werden, transparent auf (Default AN,
     `{ raw: true }` schaltet ab). `obj://`/`file://` bleiben auch hier
     explizit (`resolveReference()`/`resolveFileRef()`). Volle Erklärung,
     Beispiele und die vier Fallstricke: [Abschnitt 8](#8-referenzen-automatisch-folgen-key).
4. **Spaces** (`src/modules/spaces.js`, `createSpacesPlugin()`) — löst den
   Core-Default (nur `~<eigener-fingerprint>`) durch manifest-bewusste ACL-
   Auflösung ab: generische (UUID-)Spaces mit `writers`/`readers`/`admins`,
   und zusätzliche Writer auf einem User-Space per Manifest. Fügt
   `qu.createSpace(opts)` hinzu — ohne dieses Plugin existiert die Methode
   nicht, und `createChatRoom()`/jede Multi-Writer-Anwendung ist
   unbeschreibbar. `qu.createSpace(opts)` liefert **synchron** einen
   `QuSpace`-Node zurück (siehe unten), nicht nur die rohe Id — das
   Manifest wird im Hintergrund geschrieben (`space.ready` für eine echte
   Bestätigung). Kein Storage-/Netzwerk-Bezug, also weiterhin
   offline-sicher — aber eine echte Policy-Entscheidung, kein struktureller
   Core-Bestandteil, deshalb Plugin statt Default.

### Bundle-Größe

Real gemessen (esbuild, `--bundle --minify`, nicht geschätzt):

| Bundle | minifiziert | + gzip |
|---|---|---|
| Core (Runtime/Store/Session/Identity/Space-Handle/Clock/ACL/Verify/Crypto/Sign + `qu.js` + Memory/Null-Adapter) | 17,5 KB | 6,2 KB |
| + Store (Local/Session/IndexedDB/MemoryFileStorage) | 20,0 KB | 6,8 KB |
| + Network (`createNetworkPlugin()` + Spaces, **ohne** WebRTC) | 27,6 KB | 9,2 KB |
| + `createWebRTCPlugin()` obendrauf | 32,6 KB | 10,8 KB |

WebRTC ist deshalb ein eigenes Plugin (siehe oben): Apps, die nur über
einen eigenen Relay per WebSocket synchronisieren — der häufigste Fall —
zahlen die ~5 KB minifiziert / ~1,6 KB gzip für `RTCPeerConnection`-Code
nicht mit, den sie nie aufrufen. Vor dieser Trennung importierte
`createNetworkPlugin()` `PeerConnectionManager` unbedingt, wodurch **jede**
`qu.connect()`-Nutzung WebRTC zwangsweise mitbündelte — real gemessen
**~29 % / ~11,5 KB** weniger für den WebRTC-losen Fall seit der Trennung.

**`QuSpace`** (`src/core/space-handle.js`) ist dagegen Core, nicht Plugin —
ein reines Adressierungs-Hilfsmittel, kein Policy-Entscheid, kostet keinen
Storage-/Manifest-Zugriff, um zu *bauen*. `qu.own` (= `qu.get(qu.userSpaceId)`)
und `qu.get(id)` sind für **jede** `Qu`-Instanz da, mit oder ohne Spaces-
Plugin — nur `qu.createSpace()` (neue generische Spaces anlegen) braucht das
Plugin, weil das ein echter Manifest-Write mit Policy-Entscheidung ist.
Ein Node prüft selbst nichts: jeder `put`/`set`/`on`/`map`/`await`-Aufruf
darüber läuft exakt so durch die ACL wie derselbe Aufruf mit dem vollen
Pfad direkt auf `qu`. `toString()`/`toJSON()` machen einen Node überall
einsetzbar, wo bisher ein roher SpaceId-String erwartet wurde.

`chat.js` (`src/modules/chat.js`, `createChatPlugin()`) ist die eine
lockerere, nicht-numerierte Kategorie: ein fertiger Baustein, ausschließlich
auf der öffentlichen Runtime/Session/Qu-API aufgebaut, kein Sonderzugriff
auf den Core — eher Beispielcode als Architektur. Jede Funktion nimmt einen
bereits navigierten Space-Node entgegen (`sendMessage(space, opts)`) und ist
intern nur `space.get('msgs').set(...)`/`.map(...)` — aber `createSpace()`
(Spaces-Plugin, für den geteilten Room) bleibt nötig. Kein Netzwerk-Plugin
nötig: eine Chat-Room bleibt vollständig lokal nutzbar, nur ohne
Mehrgeräte-Sync. Anhänge brauchen zusätzlich einen `FileHandler`
(`.put(bytes)` erkennt sie automatisch); Mehrgeräte-Sync zusätzlich einen
`NetworkPlugin` — Chat selbst bleibt davon unwissend.

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
  Selbst-Ausprobieren: fünf Abschnitte (Identität, Spaces/ACL, Storage-
  Adapter, Netzwerk/Relay/Mirror, Referenzen in der Praxis), je ein
  "Ausführen"-Button, echte Objekte auf `window` für die Konsole danach
  (siehe eigener Abschnitt unten).
- **Tests** (`/test/index.html`) — dieselben `test/*.test.mjs`-Dateien wie
  `npm test`, unverändert, aber vollständig: die Dateiliste kommt live von
  `/test/manifest.json` (der Server scannt `test/` bei jeder Anfrage neu,
  keine von Hand gepflegte Liste, die veralten kann). Browser-taugliche
  Dateien laufen über eine Import-Map auf einen kleinen Shim
  (`test/browser-shim/`), gruppiert nach Datei mit Live-Ergebnissen. Die
  restlichen (echtes `node:fs`/`node:http`/`node:net`, z. B. der
  Relay-Test gegen einen echten WebSocket-Server) können nicht im Browser
  laufen — der Server bietet optional an, sie selbst auszuführen und das
  Ergebnis als JSON auszuliefern (`GET /test/run-node-tests`), damit auch
  sie im selben Dashboard auftauchen. Aus, per Default: `QU_ENABLE_TEST_ENDPOINT=1`
  beim Start setzen, um das zu aktivieren — ein Endpunkt, der bei jeder
  Anfrage einen echten Testlauf auslöst, ist für lokale Entwicklung
  unproblematisch, aber kein Endpunkt, den man ungeschützt öffentlich
  erreichbar machen möchte (Ergebnisse werden 30s gecacht, damit wiederholte
  Anfragen nicht wiederholt einen Lauf auslösen).
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
Relay-Kern eingebaut. Zwei Startmodi, per `QU_STORE`-Umgebungsvariable
gewählt (Default: persistent, unverändertes Verhalten): `QU_STORE=memory`
für flüchtig (`MemoryAdapter`/`MemoryFileStorageAdapter`, kein Datei-I/O,
für schnelle lokale Tests oder kurzlebige Relay-Instanzen), sonst persistent
(`FileSystemStorageAdapter`/`FileSystemFileStorageAdapter`, übersteht einen
Neustart) — derselbe `StorageAdapter`-Contract in beiden Fällen, austauschbar
ohne dass der Relay-Kern selbst etwas davon weiß.

**Schutz vor einem einzelnen flutenden oder fremd-weiterleitenden Peer:**
jeder eingehende `qu.push` läuft durch eine kleine Middleware-Pipeline
("Ingest-Gate", dieselbe Grundform wie `Runtime.ingest()`s eigene Verify-/
ACL-Pipeline, `core/pipeline.js`), bevor er überhaupt bei `runtime.ingest()`
ankommt — bewusst so gebaut, damit eine künftige dritte Schutzregel eine
weitere Middleware-Funktion ist, kein neuer, hart codierter Sonderfall.
Zwei eingebaute Kurzformen auf `DefaultReplication`/`qu.connect()`/
`createRelay()`, plus eine `ingestGate`-Option für eigene Middleware —
alle drei betreffen nur eingehende Pushes, nie das ausgehende Routing.
`rateLimiter` (ein `createRateLimiter()`, gleitendes Zeitfenster
pro Fingerprint) begrenzt, wie viele Writes ein einzelner Peer pro Sekunde
durch diese Verbindung schleusen darf — im Demo-Deployment (`index.js`)
standardmäßig **aktiv** (200/s, `QU_RATE_LIMIT_MAX`/
`QU_RATE_LIMIT_WINDOW_MS` einstellbar, `QU_RATE_LIMIT=0` schaltet ab), weil
hier (anders als z. B. beim Test-Endpunkt) das ungeschützte `ingest()`
selbst das Risiko ist, nicht ein zusätzlicher Endpunkt. `requireDirectWriter`
(aus per Default, `QU_REQUIRE_DIRECT_WRITER=1`) verschärft das zu einer
strikten Stern-Topologie: ein Push wird nur akzeptiert, wenn `qubit.writer`
exakt der per Handshake bewiesene Fingerprint dieser einen Verbindung ist —
kein Drittweiterleiten fremder (wenn auch gültig signierter) QuBits über
diesen Relay. Details, inklusive warum das kein Core-Default ist (bricht
legitime Mesh-/Gossip-Weiterleitung) und wie eine eigene `ingestGate`-Regel
aussieht, stehen in
[API.md](./API.md#relay-schutz-die-ingest-gate-pipeline-requiredirectwriter-ratelimiter-ingestgate).

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

`qu.webrtc(signalingChannel)` (über `qu.use(createWebRTCPlugin())` — ein
eigenes Plugin, siehe [Bundle-Größe](#bundle-größe)) liefert einen `PeerConnectionManager`;
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
- **Zwei Schreibmodi, keine Konvention:** `put(value)` ist ein
  benanntes, veränderliches Register (LWW); `set(value)`
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
  — dieselbe `put()`/`on()`-API in jeder Kombination, nur der
  `StorageAdapter`-Mount und ob ein Network-Plugin verbunden ist ändern
  sich (siehe [Grundkonzepte, Abschnitt 4](#4-arten-von-events)).
- **`QuSpace` ist Adressierung, kein Policy-Entscheid:** `qu.own`/
  `qu.get(id)`/`qu.createSpace()` geben einen an einen Space gebundenen
  Node zurück (`put`/`set`/`on`/`map` relativ dazu, gleichzeitig thenable)
  — kostet nichts, prüft nichts selbst, jeder Aufruf darüber läuft exakt so
  durch die ACL wie derselbe Aufruf mit vollem Pfad auf `qu`.
- **Alles Optionale ist ein Plugin:** Storage-Adapter jenseits von
  Memory/Null, Network (Replication/Transporte/Routing), Referenzen/
  Dateien, Spaces-ACL-Resolver und Chat sind austauschbar, docken über
  `qu.use(...)` an oder sind ganz ohne Fassade direkt aufrufbar, und
  benutzen ausschließlich die öffentliche `Runtime`/`Session`/`Qu`-API —
  der Core kennt keines von ihnen (siehe
  [Core, Storage, Network, Data](#core-storage-network-data--wie-die-plugins-zusammenspielen)).

## Status

160 `node:test`-Fälle (mehrere Assertions pro thematischem Test), alle grün,
CLI geprüft — inklusive echtem WebSocket-Relay (native Clients, nicht nur
Loopback) und echten, manuell konstruierten fragmentierten WS-Frames.
Dieselben Fälle laufen auch im vereinheitlichten Browser-Dashboard
(`test/index.html`, siehe [Abschnitt "Im Browser"](#im-browser-server-starten))
— Node-only-Dateien (echtes `node:fs`/`node:net`) optional serverseitig
mitgeliefert, sofern `QU_ENABLE_TEST_ENDPOINT=1` gesetzt ist.
Jeder `StorageAdapter` (`MemoryAdapter`/`NullAdapter` sowie die drei
Browser-only-Adapter) ist jetzt gegen denselben gemeinsamen Contract-Test
geprüft (`test/helpers.mjs`s `assertStorageAdapterContract()`) —
`LocalStorageAdapter`/`SessionStorageAdapter`/`IndexedDBAdapter` brauchen dafür
echte Browser-Globals (kein `localStorage`/`indexedDB` in Node), laufen unter
`npm test` deshalb absichtlich als dokumentierter No-op und werden erst im
Browser-Dashboard tatsächlich geprüft (`test/storage-adapters-browser.test.mjs`).
Offen: SQLite-Adapter für `StorageAdapter`/`FileStorageAdapter`
(mechanisch, kein Architekturrisiko).
