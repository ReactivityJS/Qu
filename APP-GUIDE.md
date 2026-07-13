# Eine vernetzte App mit QU bauen

Diese Anleitung baut eine kleine, echte App: mehrere Instanzen tauschen
Daten über einen gemeinsamen **App-Space** aus, verbunden über einen
echten QU-Relay per WebSocket. Kein Spielzeug-Beispiel — jeder Code-Block
hier ist copy-paste-lauffähig und wurde tatsächlich gegen einen echten,
selbst gestarteten Relay-Prozess ausgeführt (nicht nur gelesen). Dieselbe
Logik als geprüfte, getestete Bibliothek:
[`examples/app-space-lib.mjs`](./examples/app-space-lib.mjs) +
[`examples/app-space-lib.test.mjs`](./examples/app-space-lib.test.mjs)
(läuft gegen einen echten, im Test selbst gestarteten Relay, kein Mock).

Für die Grundkonzepte (get/put/set/on/map, ACL, Verschlüsselung) siehe
zuerst [README.md](./README.md) — diese Anleitung setzt sie voraus und
konzentriert sich auf das Zusammenspiel mit dem Netzwerk. Die vollständige
Aufrufreferenz jeder Funktion steht in [API.md](./API.md).

## Einen Relay für die eigene App starten

`npm start` startet zwar bereits einen laufenden Dev-Relay
(`ws://localhost:8787/relay`) — aber dessen `pushTopics` ist fest auf
`qu-demo-room/` verdrahtet (`index.js`, für das interaktive Lab). Ein
eigener App-Space unter einem anderen Namen würde von DIESEM Relay nie
live weitergeleitet (Details im Kasten unten) — für eine eigene App lohnt
sich ein eigener, minimaler Relay mehr als das Wiederverwenden des Demo-Topics:

```js
// my-relay.mjs
import http from 'node:http';
import { createRelay } from './relay/relay.mjs';
import { bridgeWebSocketServer } from './relay/node-ws-bridge.mjs';

const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
server.listen(8788);
const relayApi = await createRelay({ pushTopics: ['my-app/'] });
bridgeWebSocketServer(server, relayApi, { path: '/relay' });
console.log('Relay läuft auf ws://localhost:8788/relay');
```

```
node my-relay.mjs
```

Das ist eine gekürzte Version von `index.js` selbst — derselbe universelle
Relay-Kern (`createRelay()`, `relay/relay.mjs`), nur mit dem eigenen
App-Topic statt der Demo-Konfiguration. Alle Code-Blöcke unten gehen von
dieser laufenden Instanz aus.

> **Wichtiger Unterschied, leicht zu verwechseln:** `pushTopics` taucht an
> zwei Stellen auf, mit unterschiedlicher Bedeutung. An `createRelay({
> pushTopics })` (oben) legt es **einmalig, für den ganzen Relay-Prozess**
> fest, welche Präfixe überhaupt jemals live an EINEN VERBUNDENEN CLIENT
> weitergeleitet werden — Deployment-Konfiguration. An
> `qu.connect(channel, { pushTopics })` (Schritt 2 unten) legt es fest,
> was DIESE EINE VERBINDUNG selbst nach außen pusht (Client → Relay).
> Ein Client kann sich nicht einfach "für ein neues Topic anmelden", indem
> er es bei `connect()` angibt — der Relay muss es selbst in seiner
> eigenen `pushTopics`-Liste haben, sonst bleibt die Verbindung für dieses
> Topic stumm (kein Fehler, einfach keine Live-Zustellung). Genau dieser
> Constraint ist auch der Grund, warum das interaktive Lab
> (`docs/lab/labs/04-network-relay.mjs`) seinen Raum-Namen fest auf
> `'qu-demo-room'` setzt, statt eine zufällige Id zu erzeugen — er muss
> zum Relay passen, den `npm start` tatsächlich betreibt.

## Schritt 1: Identität

```js
import { Qu } from './src/index.js';

const alice = await Qu.create(); // neues Schlüsselpaar
console.log(alice.fingerprint);   // z. B. "3e19cdff…" — zugleich die Adresse von alice' eigenem Space (~3e19cdff…)
```

Ohne jedes Plugin ist `alice` bereits voll funktionsfähig — nur eben rein
lokal und nur unter dem eigenen `~<fingerprint>` schreibbar (README,
Abschnitt 2). Für einen geteilten App-Space kommen zwei Plugins dazu.

## Schritt 2: Verbindung zum Relay

```js
import { Qu, createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from './src/index.js';

const alice = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());

const channel = createWebSocketChannel('ws://localhost:8788/relay');
await channel.connect();
const repl = await alice.connect(channel, { pushTopics: ['my-app/'] });
```

`createSpacesPlugin()` ist hier keine Nebensache: ohne es lässt der
Core-Default (`core/identity-acl.js`) nur Schreibzugriffe auf den eigenen
`~fingerprint`-Space zu — ein geteilter App-Space (egal ob offen oder
mitgliederbeschränkt) braucht dessen manifest-bewusste ACL-Auflösung.
`pushTopics` hier ist, was ALICE selbst nach außen pusht — für Live-Empfang
muss derselbe Präfix (wie oben erklärt) auch beim Relay selbst konfiguriert
sein.

## Schritt 3: Das App-Space-Muster

Ein App-Space ist kein neues Konzept — derselbe Space wie überall sonst in
QU (Whitepaper §8), nur mit einem der App selbst bekannten Namen statt
einer zufälligen Nutzer-Id. Zwei Varianten:

**Offen** — ein fest verabredeter Name, ohne eigenes Manifest. Die
Bootstrap-Regel des Spaces-Plugins ("kein Manifest = jeder darf
schreiben", `modules/spaces.js`) macht daraus einen für jeden mit
`createSpacesPlugin()` offen mitschreibbaren, geteilten Space — genau das
Muster, das dieses Repo selbst für seinen Demo-Relay nutzt
(`index.js`s `qu-demo-room/`-Topic):

```js
const appSpace = alice.get('my-app'); // navigiert nur — keine I/O, kein Manifest nötig
```

Passend für eine öffentliche Instanz/Demo, nicht für echte
Zugriffskontrolle — jeder, der den Namen kennt, darf schreiben.

**Mitgliederbeschränkt** — `qu.createSpace({ writers, readers })`, die
entstehende zufällige Id wird z. B. über einen Link verteilt (dasselbe
Muster wie [`examples/todo-lib.mjs`](./examples/todo-lib.mjs)):

```js
const appSpace = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
await appSpace.ready; // wirklich auf das Manifest warten, bevor die Id weitergegeben wird
console.log(appSpace.id); // diese Id an weitere Mitglieder verteilen
```

Ein zweites Mitglied hinzufügen (nur Admins dürfen das, siehe README
Abschnitt 2/Whitepaper §8.3):

```js
const manifest = (await alice.get(appSpace.id)).value;
await alice.get(appSpace.id).put({ ...manifest, writers: [...manifest.writers, bob.fingerprint] });
```

Für eine zufällige Id (statt eines festen Namens) reicht `pushTopics` beim
`connect()` nicht als Präfix aus, sofern der Relay nicht ebenfalls exakt
diese Id kennt — siehe den Kasten oben. Ein Relay, der beliebige, zur
Laufzeit erzeugte App-Spaces unterstützen soll, braucht entweder ein
breites `pushTopics`-Präfix (z. B. `''`, alles) oder eine
anwendungsspezifische Konvention (z. B. `apps/<app-name>/`, sodass EIN
`pushTopics`-Eintrag beliebig viele zur Laufzeit erzeugte Spaces
darunter abdeckt).

## Schritt 4: Daten schreiben, lesen, live beobachten

Ab hier ist es exakt dieselbe API wie in README Abschnitt 2 — Netzwerk
ändert nichts an `put`/`set`/`on`/`map`, nur dass Schreibvorgänge jetzt
zusätzlich über den Relay an jede Verbindung mit passendem `pushTopics`
weitergereicht werden. Am deutlichsten mit zwei UNABHÄNGIGEN Instanzen zu
zeigen (zwei eigene Identitäten, zwei eigene Verbindungen — nicht dieselbe
Instanz, die ihren eigenen Schreibvorgang beobachtet):

```js
const bob = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const channelBob = createWebSocketChannel('ws://localhost:8788/relay');
await channelBob.connect();
await bob.connect(channelBob, { pushTopics: ['my-app/'] });

// Bob abonniert, BEVOR Alice schreibt:
bob.get('my-app').get('entries').map((q) => console.log('bob sieht:', q.value.text));

// Ein "Eintrag" — set(), weil mehrere App-Instanzen unabhängig
// voneinander schreiben können (kollisionssicher, README §7.2):
await appSpace.get('entries').set({ text: 'hallo App-Space' });
// kurz warten (die Zustellung ist asynchron), dann erscheint bei bob:
// "bob sieht: hallo App-Space"

// Alle Einträge einmalig abfragen (rein lokal, kein Netzwerk-Roundtrip):
const rows = await appSpace.session.query(`${appSpace.id}/entries/**`);
```

`map(cb)` liefert per Default erst, was lokal bereits bekannt ist, danach
laufend Neues — auch für `set()`-Sammlungen wie `entries` ohne
`{ deep: true }`, die sind genauso eine Ebene tief wie eine `put()`-basierte
Sammlung. Ohne vorherigen `sync()` (Schritt 5) kennt eine frisch verbundene
Instanz aber noch nichts, sieht also nur das, was ab jetzt live eintrifft.

## Schritt 5: Später beitreten — `sync()`

Eine Instanz, die sich erst NACH einem Schreibvorgang verbindet, hat den
Live-Push verpasst. Für bereits vorhandene Daten (den aktuellen Stand des
App-Space, **inklusive** eines eventuellen Manifests) explizit
synchronisieren:

```js
const carol = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const channelCarol = createWebSocketChannel('ws://localhost:8788/relay');
await channelCarol.connect();
const replCarol = await carol.connect(channelCarol, { pushTopics: ['my-app/'] });

await replCarol.sync({ topic: 'my-app', since: 0 }); // holt Manifest UND Inhalte, einmalig — reziprok: die Gegenseite fragt automatisch zurück
const seenByCarol = await carol.get('my-app').session.query('my-app/entries/**');
```

`since: 0` heißt "alles". Für einen später wiederkehrenden Client reicht
`since: <letzter bekannter Zeitstempel>` — nur die Differenz wird
übertragen (README Abschnitt 3).

## Schritt 6: Traffic im Blick behalten

Ein `map(cb)` auf eine strukturell unbegrenzt wachsende
Sammlung (z. B. "alle Einträge, für immer") lädt irgendwann den gesamten
App-Space — sowohl lokal als auch über die Leitung. Für alles, was über
eine überschaubare Größe hinauswachsen kann, empfiehlt sich Zeit-Sharding:
siehe [README, Abschnitt 7](./README.md#7-datenstruktur-für-wachsende-collections-z-b-ein-forum)
für die vollständige Empfehlung (inkl. lauffähigem Beispiel,
[`examples/forum-lib.mjs`](./examples/forum-lib.mjs)) — dasselbe Muster
begrenzt automatisch auch den Netzwerk-Traffic, weil `pushTopics`/`sync()`
präfixbasiert sind.

## Schritt 7: Verschlüsselung, falls gewünscht

Setzt der App-Space eine eingeschränkte `readers`-Liste (statt `['*']`),
verschlüsselt QU automatisch für genau diese Leser — kein `encryptFor`
nötig. Voraussetzung: jedes Mitglied veröffentlicht einmal sein Profil,
damit die anderen seinen Schlüssel finden (README, Abschnitt 2 unten,
sowie [API.md](./API.md#profil-qupublishprofile-qureadprofilefingerprint)):

```js
await alice.publishProfile({ alias: 'Alice' });
await bob.publishProfile({ alias: 'Bob' });
```

## Vollständiges Beispiel

Alles zusammen — zwei unabhängige Instanzen, ein offener App-Space, ein
echter Relay (gegen `node my-relay.mjs` von oben; für einen Selbsttest
ohne manuell gestarteten Server siehe `examples/app-space-lib.test.mjs`,
das denselben Relay im Test selbst hochfährt):

```js
import { Qu, createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from './src/index.js';

async function makeInstance() {
  const qu = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const channel = createWebSocketChannel('ws://localhost:8788/relay');
  await channel.connect();
  const repl = await qu.connect(channel, { pushTopics: ['my-app/'] });
  return { qu, channel, repl };
}

const a = await makeInstance();
const b = await makeInstance();

b.qu.get('my-app').get('entries').map((q) => console.log('b sieht:', q.value.text));

await a.qu.get('my-app').get('entries').set({ text: 'hallo von a' });
// kurz warten, dann ist bei b in der Konsole "b sieht: hallo von a" zu sehen

a.channel.close();
b.channel.close();
```

Tatsächlich ausgeführt gegen einen echten, lokal gestarteten Relay:
`a connected` → `b connected` → `write result: {"accepted":true,...}` →
**`b sieht: hallo von a`**.

## Weiterführend

- **Vollständige Aufrufreferenz** jeder hier genutzten Funktion: [API.md](./API.md)
  ([`qu.connect()`](./API.md#replication-optionales-modul-hier-bequem-verdrahtet),
  [`createSpacesPlugin()`](./API.md#spaces-modul),
  [Relay-Schutz (Rate-Limit, Ingest-Gate)](./API.md#relay-schutz-die-ingest-gate-pipeline-requiredirectwriter-ratelimiter-ingestgate)
  für einen selbst betriebenen Relay).
- **Mitgliederbeschränkte App-Spaces, praktisch**: [`examples/todo-lib.mjs`](./examples/todo-lib.mjs)
  (rein lokal) — dasselbe `createSpace()`-Muster, das Schritt 3 oben zeigt.
- **Zeit-Sharding für wachsende Daten**: [README, Abschnitt 7](./README.md#7-datenstruktur-für-wachsende-collections-z-b-ein-forum)
  und [`examples/forum-lib.mjs`](./examples/forum-lib.mjs).
- **Einen Relay produktiv betreiben** (statt des minimalen Beispiels oben):
  [`relay/relay.mjs`](./relay/relay.mjs)s `createRelay()`, verdrahtet in
  [`index.js`](./index.js) — inklusive Rate-Limit
  (`QU_RATE_LIMIT_MAX`/`QU_RATE_LIMIT_WINDOW_MS`) und optionaler
  Stern-Topologie (`QU_REQUIRE_DIRECT_WRITER=1`), siehe README "Der Relay
  ist universell, nicht Chat-spezifisch".
