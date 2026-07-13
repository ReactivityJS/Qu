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

> Diese Anleitung nutzt eine feste `pushTopics`-Konfiguration, weil sie
> mit EINEM festen App-Space arbeitet (Schritt 3). Legt eine App ihre
> Space-Ids dagegen erst zur Laufzeit an (`qu.createSpace()`, mehrere
> unabhängige Räume), passt ein fest im Relay hinterlegtes `pushTopics`
> nicht — dafür gibt es `allowDynamicSubscribe`, mit dem der Relay
> App-unabhängig laufen kann und Clients ihr Interesse selbst anmelden;
> siehe den Kasten in Schritt 3 sowie README Abschnitt 3.

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

`pushTopics` hier ist, was ALICE selbst nach außen pusht. **Es gibt kein
separates "Topic"-Konzept in QU** — ein Topic ist einfach ein
String-Präfix, der gegen QuBit-Ids geprüft wird (`id.startsWith(präfix)`).
Die robusteste Wahl dafür ist deshalb IMMER die App-Space-Id selbst
(unten): `'my-app'` ist hier kein austauschbares Label, das zufällig zum
späteren App-Space passt — es IST die App-Space-Id, vorgezogen, weil sie
für diese eine App bereits jetzt feststeht (siehe Schritt 3). Für
Live-Empfang muss derselbe Präfix (wie oben erklärt) auch beim Relay
selbst konfiguriert sein.

## Schritt 3: Das App-Space-Muster

Ein App-Space ist kein neues Konzept — derselbe Space wie überall sonst in
QU (Whitepaper §8), nur mit EINER der App selbst bekannten, festen Id statt
einer bei jedem Aufruf neu erzeugten. Genau diese Eigenschaft — eine feste,
vorher bekannte Id statt einer zufälligen — ist es, die die App-Space-Id
zur natürlichen Wahl für `pushTopics`/`sync({ topic })` macht: Adressierung
im Code (`qu.get(id)`) und Netzwerk-Topic sind dieselbe Zeichenkette, nicht
zwei getrennte Dinge, die zufällig übereinstimmen müssen. Zwei Varianten,
beide mit fester Id:

> **In einer echten App: die feste Id selbst per `crypto.randomUUID()`
> erzeugen, nicht einen lesbaren Namen wie `'my-app'` wählen.** Space-Ids
> sind global — läuft die App auf geteilter Infrastruktur (ein öffentlicher
> Demo-Relay, ein Multi-Tenant-Server), kollidiert ein lesbarer Name mit
> jeder anderen App, die zufällig denselben gewählt hat; eine UUID
> praktisch nie. Der Mechanismus ändert sich dadurch NICHT — `'my-app'`
> unten ist nur zur Lesbarkeit dieser Anleitung gewählt, in echtem Code
> wäre es `const APP_SPACE_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';`
> (einmalig erzeugt, fest im Quellcode). Einen lesbaren Namen braucht die
> App trotzdem oft — der gehört dann als eigenes Datenfeld AN den Space,
> nicht IN dessen Id (siehe [`setLabel()`/`getLabel()`](./examples/space-index-lib.mjs)
> unten): `appSpace.get('label').put('Mein App-Name')`, exakt dieselbe
> Konvention wie `~<fp>/alias` fürs Nutzerprofil (README Abschnitt 2).
> Extra-Felder direkt in `createSpace()`/`createSpaceAt()`s `opts`
> (`{ writers, readers, label }`) werden dagegen stillschweigend verworfen
> — das Manifest kennt nur `admins`/`writers`/`readers`/`createdAt`.

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

**Mitgliederbeschränkt** — `qu.createSpaceAt(id, { writers, readers })`:
dieselbe manifest-basierte Zugriffskontrolle wie `qu.createSpace(opts)`
(README Abschnitt 2), nur mit einer selbst gewählten statt einer
zufälligen Id — für genau diesen einen Zweck gemacht (eine App hat EINEN
App-Space, nicht viele unabhängig angelegte Räume; für "viele Räume", z. B.
mehrere ToDo-Listen oder Chat-Räume mit je einer eigenen, unvorhersehbaren
Id, ist `qu.createSpace(opts)` weiterhin das richtige Werkzeug — siehe
[`examples/todo-lib.mjs`](./examples/todo-lib.mjs)):

```js
const APP_SPACE = 'my-app';
const appSpace = alice.createSpaceAt(APP_SPACE, { writers: [alice.fingerprint], readers: ['*'] });
await appSpace.ready; // wirklich auf das Manifest warten, bevor andere Mitglieder mitschreiben
```

Derselbe First-Write-Wins-Bootstrap wie bei `qu.createSpace()` gilt
unverändert: bis zu diesem allerersten Schreiben darf jeder unter dieser
Id schreiben (auch das Manifest selbst) — für eine feste, im Quellcode
sichtbare Id ist das Fenster meist kurz (die erste Instanz, die die App
startet, gewinnt), aber es ist kein Zufalls-Wettlauf mehr wie bei einer
frisch generierten UUID, sondern ein Deployment-Detail: wer die App zuerst
mit Netzwerkzugriff startet, sollte diesen ersten Schreibvorgang auslösen.

Ein zweites Mitglied hinzufügen (nur Admins dürfen das, siehe README
Abschnitt 2/Whitepaper §8.3):

```js
const manifest = (await alice.get(APP_SPACE)).value;
await alice.get(APP_SPACE).put({ ...manifest, writers: [...manifest.writers, bob.fingerprint] });
```

Weil `APP_SPACE` fest und vorher bekannt ist, deckt derselbe
`pushTopics: [APP_SPACE]`/`pushTopics: ['my-app/']`-Präfix aus Schritt 2
sowohl das Manifest (`id === APP_SPACE`, kein Slash) als auch alle
verschachtelten Inhalte (`${APP_SPACE}/entries/...`) ab — kein separater
Präfix, keine Sonderbehandlung nötig.

**Für `qu.createSpace()`s zufällige, erst zur Laufzeit entstehende Id**
(mehrere unabhängige Räume statt eines einzigen festen App-Space, siehe
oben) passt ein statisch im Relay hinterlegtes `pushTopics` naturgemäß
nicht — die Id steht beim Start des Relay-Prozesses noch gar nicht fest.
`allowDynamicSubscribe` löst das für die LESENDE Seite: der Relay selbst
braucht kein vorab konfiguriertes `pushTopics` mehr, jeder lesende Client
meldet sein Interesse an genau der Id, die er kennt, selbst zur Laufzeit an.
Die SCHREIBENDE Seite (wer den Space erzeugt) pusht dafür weiterhin über
ihr eigenes `pushTopics` bei `connect()` — unverändert, keine neue Funktion
— nur eben mit einem breiten `''`-Präfix statt eines festen Namens, weil
sie die künftigen Space-Ids beim Verbinden noch nicht kennt:

```js
const relayApi = await createRelay({ allowDynamicSubscribe: true }); // oder z.B. ['apps/'] als harte Obergrenze

// Alice erzeugt Spaces zur Laufzeit — pusht deshalb alles, was sie selbst
// schreibt, statt eines festen Präfixes (bereits vorher bestehende Option):
const replAlice = await alice.connect(channelAlice, { pushTopics: [''] });

// Bob kennt eine konkrete Space-Id (z. B. aus einem Link) und meldet NUR
// dafür Interesse an — ganz ohne dass der Relay sie vorher kennen musste:
const repl = await bob.connect(channelBob, { pushTopics: [] });
bob.get(newlyCreatedSpaceId).get('entries').map((q) => …); // löst automatisch repl.ensureSynced(...) aus — sync + subscribe, einmalig
```

`pushTopics: ['']` bei Alice bedeutet nur "der Relay bekommt alles zu
sehen, was sie schreibt" — was DAVON tatsächlich an einen bestimmten Leser
zugestellt wird, entscheidet weiterhin ausschließlich die ACL (README
Abschnitt 2), unabhängig vom breiten Präfix. Kein
`apps/<app-name>/`-Konventions-Präfix mehr nötig, um "beliebig viele"
künftige Ids abzudecken — jede wird individuell und erst bei tatsächlichem
Lese-Bedarf angemeldet (Details inkl. der Sicherheits-Grenzen von
`allowDynamicSubscribe`/`maxDynamicTopics` in README Abschnitt 3 und
[API.md](./API.md#replication-modul)).

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

## Schritt 8: Mehrere Boards/ToDo-Listen — Sub-Spaces referenzieren

Bisher: EIN App-Space für die ganze App. Braucht die App mehrere davon
(mehrere Boards, mehrere ToDo-Listen, ein Space pro Team), ist das kein
neuer Mechanismus, nur eine Ebene mehr: eine Id ist eine Id, und ein
QuBit-Feld kann ganz gewöhnlich die Id eines ANDEREN Space enthalten.
`qu.get(diese-id)` navigiert dorthin, egal ob "diese-id" aus dem eigenen
Space kommt oder nicht.

```
App-Space --(Label "Team Alpha")--> Sub-Space-Id --(qu.get)--> Sub-Space (eigenes Manifest)
```

Jeder Sub-Space entsteht ganz normal mit `qu.createSpace({ writers, readers })`
(frische, zufällige Id — anders als der App-Space selbst braucht ein
einzelnes Board KEINE feste, vorher bekannte Id, siehe
[`examples/todo-lib.mjs`](./examples/todo-lib.mjs)) und bekommt dadurch
sein EIGENES, vom App-Space komplett unabhängiges Manifest:

```js
const boardAlpha = alice.createSpace({ writers: ['*'], readers: ['*'] });
await boardAlpha.ready;
await boardAlpha.get('label').put('Team Alpha');

const boardBeta = alice.createSpace({ writers: ['*'], readers: ['*'] });
await boardBeta.ready;
await boardBeta.get('label').put('Team Beta');

// Im App-Space registrieren — set(), weil mehrere Nutzer unabhängig
// voneinander neue Boards/Listen anlegen können:
await appSpace.get('boards').set({ label: 'Team Alpha', spaceId: boardAlpha.id });
await appSpace.get('boards').set({ label: 'Team Beta', spaceId: boardBeta.id });

// Auflisten (einmalig) oder live abonnieren:
const index = await appSpace.session.query(`${appSpace.id}/boards/**`);
appSpace.get('boards').map((q) => console.log('neu registriert:', q.value.label));

// Navigieren: die referenzierte Id ist ein ganz normaler Space.
const board = alice.get(index[0].value.spaceId);
```

Ein Board mit mitgliederbeschränktem Zugriff (statt `writers: ['*']`) folgt
exakt demselben Muster wie der mitgliederbeschränkte App-Space in Schritt 3
(feste `readers`-Liste, `publishProfile()` für automatische Verschlüsselung,
siehe Schritt 7) — der Index-Eintrag selbst kennt keinen Unterschied
zwischen einem offenen und einem eingeschränkten Ziel, er trägt in beiden
Fällen nur `{ label, spaceId }`. Ein vollständiges, getestetes Beispiel
inklusive eines mitgliederbeschränkten Boards neben einem offenen (rein
lokal, ohne Netzwerk-Overhead, dafür mit derselben ACL-Logik) steht in
`examples/space-index-lib.test.mjs`.

**Wichtig, leicht zu übersehen:** der Index-EINTRAG (Label + Sub-Space-Id)
ist nur so privat wie der App-Space selbst, NICHT so privat wie der
referenzierte Sub-Space. Wer den App-Space lesen darf, sieht IMMER
Label + Id jedes registrierten Boards — auch eines, dessen INHALT er gar
nicht lesen darf (dessen Inhalt bleibt trotzdem durch die eigene ACL
geschützt, nur Existenz+Label sind sichtbar). Für ein wirklich geheimes
Board (dessen Existenz selbst verborgen bleiben soll) den Index-Eintrag
nicht im offenen App-Space ablegen, sondern die Id z. B. per Direktlink
verteilen, wie in Schritt 3.

Fertige, getestete Bibliothek für dieses Muster (`setLabel`/`getLabel`/
`registerSpace`/`listSpaces`/`onSpaceRegistered`), inklusive Test für genau
diese Sichtbarkeits-Falle:
[`examples/space-index-lib.mjs`](./examples/space-index-lib.mjs) +
[`examples/space-index-lib.test.mjs`](./examples/space-index-lib.test.mjs).

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
