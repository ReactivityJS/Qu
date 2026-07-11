# QU — Beispiele

Drei fokussierte Beispiele, jedes für sich verständlich, jedes deutlich
kürzer als die [Live-Chat-Demo](/demo/live-chat.html). Für die vollständige
API-Referenz siehe [`API.md`](/API.md), für die Architektur-Begründung das
[Whitepaper](/qu-whitepaper-v0.6.md).

## 1 · Lokaler User (`01-local-user.mjs`)

```
node examples/01-local-user.mjs
```

Die kleinstmögliche QU-Nutzung: eine Identität, ein lokaler Store, kein
Netzwerk. Zeigt `publish()` (benannter, veränderlicher Wert), `append()`
(kollisionssichere Sammlung), `query()`, `on()` — die vier Methoden, die für
fast jede lokale Anwendung reichen.

## 2 · Zwei Clients verbinden (`02-two-clients.mjs`)

```
node examples/02-two-clients.mjs
```

Zeigt, wie zwei unabhängige `Qu`-Instanzen (eigene Identität, eigene
Runtime — wie zwei echte Geräte) über einen `Channel` verbunden werden:

```js
alice.use(createNetworkPlugin());
bob.use(createNetworkPlugin());
const { a, b } = createLoopbackChannelPair();
const [replAlice, replBob] = await Promise.all([
  alice.connect(a, { pushTopics: ['room/'] }),
  bob.connect(b, { pushTopics: ['room/'] }),
]);
```

`connect()` — added to a `Qu` instance by `qu.use(createNetworkPlugin())`,
part of Core's optional Network plugin category, not built into the facade
itself — erledigt drei Dinge in einem Aufruf: Identitäts-Handshake
(Challenge-Response, kein Vertrauen auf Zuruf), Replication-Verdrahtung,
und liefert ein Objekt mit `.sync()`/`.repair()`/`.close()`. Läuft über
einen **Loopback-Channel** — denselben `Channel`-Vertrag, den auch eine
echte WebSocket-Verbindung erfüllt, nur ohne echtes Netzwerk. Für eine
*echte* Verbindung zwischen zwei Browser-Tabs: derselbe Code, nur
`createWebSocketChannel(url)` statt `createLoopbackChannelPair()` — siehe
`demo/live-chat.mjs`.

Zeigt außerdem: Live-Push (kein `sync()` nötig, solange die Verbindung
steht) und reziproken Sync (ein einziger `sync()`-Aufruf holt auch das, was
die Gegenseite geschrieben hat, ohne dass die aktiv gefragt werden musste).

## 3 · Teilbare ToDo-Liste (`03-todo-list.html`)

Läuft im Browser gegen den echten Relay (`npm start`, dann
`/examples/03-todo-list.html` öffnen). Die eigentliche Logik steht getrennt
von der Oberfläche in `todo-lib.mjs` — dadurch mit `node --test
examples/todo-lib.test.mjs` prüfbar, ganz ohne Browser.

**Kernidee: eine Liste ist nur ein `Space`.**

```js
const listId = await qu.createSpace({ writers: [qu.fingerprint], readers: ['*'] });
```

- **Teilen** heißt: die Space-ID in einen Link packen (`?list=<id>`). Wer
  den Link öffnet, kann die Liste sofort *lesen* (`readers: ['*']`).
- **Schreibrecht ist explizit, nicht durch den Link selbst.** Eine neue
  Person zeigt ihren eigenen Fingerprint (im Beispiel prominent mit
  Kopier-Button), schickt ihn dem Besitzer/der Besitzerin auf beliebigem
  Weg (Chat, E-Mail, persönlich), die trägt ihn ein:

  ```js
  await qu.publish(listId, { ...manifest, writers: [...manifest.writers, neuerFingerprint] });
  ```

  Das ist eine Manifest-Änderung — nur wer in `admins` steht, darf das
  (Whitepaper §8.3). Ein Link allein gibt also nie Schreibrecht, nur
  Sichtbarkeit.
- **Einträge** nutzen `append()` (jede Person kann unabhängig neue
  hinzufügen, kollisionssicher), **Status ändern/Löschen** nutzt
  `publish()` auf dieselbe ID (ein benannter, veränderlicher Wert — kein
  neuer Eintrag). Jede*r Writer der Liste darf jeden Eintrag ändern, nicht
  nur die eigenen — das ist Absicht bei einer gemeinsamen Liste, nicht ein
  Nebeneffekt.

Bewusst weggelassen, um das Beispiel fokussiert zu halten: Reconnect-
Handling bei Verbindungsabbruch (siehe `demo/live-chat.mjs` für die
vollständige Version), Presence, Verschlüsselung.

## 4 · WebRTC-Direktverbindung (`04-webrtc.html`)

**Nicht automatisiert getestet** (kein Browser/WebRTC in der Umgebung, in
der dieses Projekt gebaut wurde) — sorgfältig nach dem getesteten
`PeerConnectionManager` gebaut, aber ein echter Test in zwei Browser-Tabs
steht noch aus.

Zeigt den vollständigen Ablauf einer Direktverbindung zu einem
Fingerprint, ohne dass der Relay als Datenpfad dient (er wird nur für das
Signaling gebraucht — SDP/ICE-Austausch als geroutetes Event, siehe unten):

```js
qu.use(createNetworkPlugin());                   // adds qu.webrtc()/qu.connect()/qu.router
const pm = qu.webrtc(signalingChannel);          // signalingChannel: die bestehende Relay-Verbindung
const { channel, repl } = await pm.connectDirect(peerFingerprint, { pushTopics: ['direct/room/'] });
// ... normales qu.append()/qu.on() über diese Verbindung, wie bei jedem anderen Channel ...
pm.disconnect(peerFingerprint);
```

Vor der Freigabe für Replication läuft **erneut** der QU-Handshake über
den neuen Datenkanal — WebRTC/DTLS verschlüsselt, beweist aber keine
Identität. `pm.onConnect((peerFp, entry) => {...})` feuert einheitlich für
ausgehende (`connectDirect()`) UND eingehende Verbindungen (jemand ruft
uns an — `onIncomingConnection`-Hook entscheidet, ob überhaupt
angenommen wird).

**Audio/Video** sind zusätzliche Tracks auf DERSELBEN
`RTCPeerConnection`, keine zweite Verbindung:

```js
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
for (const track of stream.getTracks()) entry.channel.peerConnection.addTrack(track, stream);
// löst automatisch eine Renegotiation aus — Perfect Negotiation ist in
// webrtc-channel-browser.mjs bereits verdrahtet, kein zusätzlicher Code nötig.
```

`entry.channel.peerConnection` ist eine bewusste Fluchttür (nicht Teil des
`Channel`-Contracts) — genau dafür gedacht.

Geroutete Events (`core/routed-events.js`) sind die dritte QU-Kategorie
neben gespeicherten Daten (`publish`/`append`) und lokalen Events
(`runtime.emit`): nie gespeichert, an genau einen Fingerprint geroutet
(nicht an alle Subscriber eines Topics broadcastet). WebRTC-Signaling ist
nur die erste Nutzung davon — der Relay interpretiert `event`/`payload`
nie, ein beliebiger anderer Event-Name funktioniert identisch.
