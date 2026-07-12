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
2. [QuSpace](#quspace) — an einen Space gebundenes Handle (`qu.own`/`qu.space(id)`)
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
13. [Files-Modul](#files-modul) — Datei-Transfer
14. [Chat-Modul](#chat-modul) — Räume, Nachrichten, Anhänge
15. [UI-Bindings-Modul](#ui-bindings-modul) — viewKey/viewObject/bindKey/bindObject
16. [UI-Components-Modul](#ui-components-modul) — `<qu-view>`/`<qu-bind>`/`<qu-list>`

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

### Daten (delegiert an die zugrundeliegende `QuSession`)
`qu.publish(id, value, opts?)` · `qu.append(collectionId, value, opts?)` ·
`qu.get(id)` · `qu.query(pattern)` · `qu.on(pattern, cb, opts?)` ·
`qu.resolveRefs(qubit)` · `qu.trustPeer(fp, encPubJwk)`
— Parameter identisch zu [`QuSession`](#qusession) (`opts` bei `on()`:
`{ initial, once }`, siehe dort). Jede Schreib-Methode
wirft sofort, wenn `qu.isGuest === true`.

**`publish` vs. `append` — zwei Schreibmodi, keine Konvention:**
`publish(id, value)` ist ein benanntes, veränderliches Register (LWW) — der
*gleiche* `id` von zwei verschiedenen Schreibern überschreibt sich
gegenseitig (kein Sicherheitsproblem, beide Signaturen sind echt, aber ein
echter Datenverlust, falls das nicht gewollt war). `append(collectionId,
value)` ist der andere Modus: es hängt `/${fingerprint}/${ts}` an die ID an,
*bevor* es denselben `publish()`-Pfad durchläuft — zwei verschiedene
Schreiber können dadurch strukturell nie kollidieren, ohne dass die ACL
davon etwas mitbekommen müsste (sie prüft weiterhin nur
`spaceIdOf(id)`, das erste Pfadsegment, unverändert). Für "viele
unabhängige Beiträge zu einer gemeinsamen Sammlung" (Chat-Nachrichten,
Kommentare, Aktivitäts-Events) immer `append()`, nie `publish()` mit einer
selbstgewählten, potenziell wiederverwendeten ID.

### Profil — einzelne Felder direkt unter der User-Space-Root
**Kein** `~<fp>/profile`-Objekt — `alias`, `pub`, `epub` (und beliebige
weitere Felder) liegen als eigene QuBits direkt unter `~<fp>`, dem
User-Space selbst.

```js
await alice.publishProfile({ alias: 'alice', epub: (await alice.exportKeys()).encPub });
// schreibt: ~<fp>/pub, ~<fp>/alias, ~<fp>/epub

const profile = await bob.readProfile(alice.fingerprint);
// { alias: 'alice', pub: '<fp>', epub: {...JWK} }
```

### Spaces & Space-Handles
`qu.own` → `QuSpace` — gebunden an den eigenen User-Space (`qu.space(qu.userSpaceId)`), immer verfügbar, kein Plugin nötig.
`qu.space(spaceId)` → `QuSpace` — gebunden an einen beliebigen bekannten Space (eigener, `~<fremder-fp>`, oder generische Space-Id); baut nur das Handle, prüft nichts.
`qu.createSpace({ writers?, readers?, admins? })` → `Promise<QuSpace>` —
wie [`createSpace()`](#spaces-modul) (Modul-Funktion, braucht das
Spaces-Plugin), aber ohne die Session separat zu übergeben, und liefert
direkt ein `QuSpace`-Handle für den neuen Space statt nur der rohen Id —
siehe [`QuSpace`](#quspace).

### Replication (optionales Modul, hier bequem verdrahtet)
`qu.connect(channel, { pushTopics?, role?, group?, metric? })` → `Promise<DefaultReplication>` —
führt zuerst `authenticateChannel()` aus, verdrahtet danach
`DefaultReplication` mit dem bewiesenen Fingerprint. Das Replication-Objekt
hat weiterhin `.sync()`/`.repair()`/`.snapshot()`/`.peerFingerprint`/`.close()`.

`role`/`group`/`metric` sind optional und rein additiv — ohne sie
identisches Verhalten wie zuvor. Mit `role: 'mirror'` oder `role: 'sync'`
wird die Verbindung zusätzlich bei `qu.router` registriert (siehe
[`Router`](#router-webrtc)) und deren Push-Entscheidung fortan davon
mitbestimmt. `qu.router` (lazy, bei erstem Zugriff erzeugt) und
`qu.webrtc(signalingChannel, opts?)` (liefert einen
`PeerConnectionManager`, siehe dort) — Details siehe
[Router & WebRTC](#router-webrtc) weiter unten.

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

### Files (optionales Modul, hier bequem verdrahtet)
`qu.shareFile(id, bytes, opts)` → wie [`publishFile()`](#files-modul), Session
bereits gebunden.
`qu.fileTransfer(channel, fileStorage)` → `DefaultFileTransfer`, Runtime
bereits gebunden.

### Chat (optionales Modul, hier bequem verdrahtet)
`qu.createChatRoom(memberFingerprints, opts?)` · `qu.sendMessage(spaceId, { text, attachments?, encryptFor? })` ·
`qu.listMessages(spaceId)` · `qu.onMessage(spaceId, cb)` — siehe
[Chat-Modul](#chat-modul) für Details.

```js
const alice = await Qu.create();
const bob = await Qu.create();
const { a, b } = createLoopbackChannelPair();

const [replAlice, replBob] = await Promise.all([alice.connect(a), bob.connect(b)]);
await alice.publish('chat/room1/msg1', 'hallo');
await replBob.sync({ topic: 'chat/room1', since: 0 });
```

---

## QuSpace

Ein dünnes, zustandsloses Handle, gebunden an einen Space (`src/core/space-handle.js`)
— dieselbe `publish`/`append`/`get`/`query`/`on`-Oberfläche wie `Qu` selbst,
nur dass jeder Pfad relativ zu diesem Space aufgelöst wird, statt jedes Mal
vollständig ausgeschrieben zu werden. Kein neuer Identitäts-/Session-
Mechanismus — es wrappt dieselbe `QuSession`, die eine `Qu`-Instanz ohnehin
schon hat, also werden Writes exakt so signiert/ACL-geprüft, als hättest du
`qu.publish()` mit dem vollen Pfad selbst aufgerufen. Ein Handle prüft
nichts beim Bauen — nur die tatsächlichen Aufrufe darüber, genau wie sonst.

Drei Wege, eines zu bekommen (siehe [Qu — Facade](#qu-facade-empfohlener-einstieg)):
- `qu.own` — gebunden an den eigenen User-Space, immer verfügbar.
- `qu.space(spaceId)` — gebunden an jeden bekannten Space (eigener, `~<fremder-fp>`, generisch).
- `qu.createSpace(opts)` — legt einen neuen generischen Space an (Spaces-Plugin nötig) und gibt direkt ein Handle dafür zurück.

### `new QuSpace(session, spaceId, { guest? })`
Niedrigerer Konstruktor — `qu.own`/`qu.space()` nutzen ihn intern, direkt
aufrufbar für eine `QuSession` ganz ohne `Qu`-Fassade.

### `space.id` → `string`
Die rohe Space-Id.

### `space.toString()` / `space.toJSON()`
Beide liefern `space.id` — ein `QuSpace` ist damit überall einsetzbar, wo
bisher ein roher SpaceId-String erwartet wurde: `` `${space}/msg` `` (Template-
Literal-Interpolation), `JSON.stringify({ space })` (auch verschachtelt),
und sogar direkt als `id`-Argument an `qu.publish(space, ...)`/`qu.get(space)`
— `QuSession`s öffentliche Methoden coercen jedes `id`/`pattern`-Argument
mit `String(...)`, bevor sie es verwenden.

### `space.publish(subpath, value, opts?)` / `space.append(subpath, value, opts?)`
Wie `qu.publish`/`qu.append`, aber `subpath` wird zu `${space.id}/${subpath}`
aufgelöst — ein leerer/weggelassener `subpath` adressiert `space.id` selbst
(z. B. das Space-Manifest). Wirft für eine Guest-gebundene `Qu`-Instanz,
identisch zu `qu.publish()`.

### `space.get(subpath?)` / `space.query(pattern)` / `space.on(pattern, cb, opts?)`
Wie die entsprechenden `qu`-Methoden, `subpath`/`pattern` ebenso relativ zu
`space.id` aufgelöst.

```js
const alice = await Qu.create();
await alice.own.publish('status', 'online');           // == alice.publish(`${alice.userSpaceId}/status`, 'online')

alice.use(createSpacesPlugin());
const room = await alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
await room.publish('msg1', 'hallo');                    // == alice.publish(`${room.id}/msg1`, 'hallo')

const bob = await Qu.create({ runtime: alice.runtime });
const sameRoom = bob.space(room.id);                    // dieselbe Space-Id, unabhängig rekonstruiert (z. B. aus einem Link)
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
`'chat/room1/**'`.

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
qu.on(`${room}/msgs/**`, renderMessage, { initial: true });

// Einmaliger Snapshot über dasselbe Interface wie der Rest der API:
qu.on(`${room}/msgs/**`, renderMessage, { once: true });
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
| `opts.encryptFor` | `string[]` | — | Fingerprints der Empfänger; verschlüsselt `value` vor dem Signieren (ECDH+HKDF+AES-256-GCM) |

Signiert (falls `identity` gesetzt), dann `runtime.ingest()`.
**Rückgabe:** wie `runtime.ingest()`.

### `session.append(collectionId, value, opts?)`
Wie `publish()`, aber hängt zuerst `/${identity.fingerprint}/${ts}` an
`collectionId` an. **Erfordert eine Identität** (wirft sonst — ein
anonymer Schreiber kann nicht sinnvoll namensraumisiert werden). Für
Sammlungen mit mehreren unabhängigen Schreibern (Chat-Nachrichten,
Kommentare) statt `publish()` mit einer selbstgewählten ID — siehe die
`publish` vs. `append`-Erklärung im [`Qu`-Abschnitt](#qu-facade-empfohlener-einstieg).

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
öffentlichen Profil des Peers gelesen (`~<fp>/epub`, siehe `Qu.readProfile()`), nicht
manuell verteilt.

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
Erzeugt einen neuen generischen Space: generiert eine UUID, veröffentlicht
das Manifest-QuBit (`session.publish(spaceId, { admins, writers, readers, createdAt })`).
`admins` defaultet auf `[session.fingerprint]`. Liefert die rohe Id als
String — für ein `QuSpace`-Handle stattdessen `qu.createSpace(opts)` nutzen
(siehe [`QuSpace`](#quspace)), die Fassaden-Sugar-Methode, die intern genau
diese Funktion aufruft und das Ergebnis in `qu.space(spaceId)` einwickelt.

```js
const acl = createSpaceACLResolver(runtime);
runtime.use(createACLPlugin(acl));
const session = new QuSession(runtime, { identity: alice, getACL: acl });

const roomId = await createSpace(session, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });
await session.publish(`${roomId}/msg1`, { text: 'hi' });
```

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
`append()` (siehe [`QuSession`](#qusession)); hier steht nur bequeme
Namensgebung und Anhang-Behandlung obendrauf.

### `createChatRoom(qu, memberFingerprints, { readers? })` → `Promise<SpaceId>`
`readers` defaultet auf `memberFingerprints` (nur Mitglieder lesen). Für
einen öffentlich lesbaren Raum explizit `readers: ['*']` übergeben.

### `sendMessage(qu, spaceId, { text, attachments?, encryptFor? })`
| Parameter | Typ | Beschreibung |
|---|---|---|
| `attachments` | `{ bytes, name, mime, fileStorage }[]` | Jeder Anhang wird als eigenes File-Manifest veröffentlicht (kollisionssicher adressiert wie Nachrichten selbst) und per `refs` an die Nachricht gehängt — Foto, Video und beliebige Datei unterscheiden sich nur im `mime`-Feld. |
| `encryptFor` | `string[]` | Wie bei `publish()` — für Ende-zu-Ende-verschlüsselte Räume. |

Ruft intern `qu.append(\`${spaceId}/msgs\`, { text }, { refs })` auf.

### `listMessages(qu, spaceId)` → `Promise<QuBit[]>`
Alle Nachrichten, älteste zuerst (`query()` + Sortierung nach `ts`). Jede
trägt weiterhin ihr geprüftes `writer`-Feld — **eine Oberfläche muss dieses
Feld für die Autorenanzeige nutzen, nie den ID-Text interpretieren** (siehe
Warnung unten).

### `onMessage(qu, spaceId, callback, opts?)` → `() => void`
Live-Subscription auf neue Nachrichten (`qu.on` unter der Haube — `opts`
wird 1:1 durchgereicht, siehe `{ initial, once }` bei `runtime.on()`).
`onReadReceipt(qu, spaceId, callback, opts?)` und
`onPresenceChange(qu, spaceId, callback, opts?)` verhalten sich identisch.

> **Wichtig:** Die ID einer Nachricht enthält den Fingerprint des
> Schreibers nur als Adressierungs-Konvention (damit verschiedene
> Schreiber nie kollidieren, siehe `append()`) — sie ist **keine
> Vertrauensquelle**. Ein böswilliger Schreiber kann einen Pfad konstruieren,
> der wie der Namensraum eines anderen aussieht (`.../msgs/<fremder-fp>/...`)
> — das signierte `writer`-Feld des empfangenen QuBits bleibt davon
> unberührt und zeigt weiterhin unweigerlich den tatsächlichen Autor. Jede
> Chat-Oberfläche muss Autorschaft ausschließlich aus `writer` ableiten.

```js
const alice = await Qu.create();
const bob = await Qu.create({ runtime: alice.runtime });
const roomId = await alice.createChatRoom([alice.fingerprint, bob.fingerprint]);

await alice.sendMessage(roomId, { text: 'hey bob' });
await alice.sendMessage(roomId, {
  text: 'ein Bild',
  attachments: [{ bytes: imageBytes, name: 'photo.png', mime: 'image/png', fileStorage }],
});

// Historie + live weiterhören in einem Aufruf, statt query() + on() von Hand zu kombinieren:
bob.onMessage(roomId, (msg) => console.log(msg.writer, msg.value.text), { initial: true });
```

---

## UI-Bindings-Modul

Reaktive View-/Bindung-Primitive in reinem JS (`src/ui/bindings.js`) —
DOM-Library-agnostisch (kein `document.*` in dieser Datei; `createItem`/
`render`/Element-Get-Set kommen vom Aufrufer), fully unit-testbar mit
Mock-Objekten statt einem echten Browser (siehe `test/ui-bindings.test.mjs`).
Basis für das [UI-Components-Modul](#ui-components-modul) darunter — eine
Component IST nichts als eine dieser Funktionen, aufgerufen aus
`connectedCallback()`, mit dem zurückgegebenen `off()` in
`disconnectedCallback()`.

### `viewKey(qu, id, render)` → `() => void`
One-way, ein einzelner QuBit. `render(value, qubit)` läuft einmal für den
aktuellen Stand (via `on(id, cb, { initial: true })`), danach bei jeder
Änderung. Dedupliziert über `(id, ts)`, nicht per Wertevergleich — dieselbe
Idee wie `QuStore.put()`s Same-ts-Noop-Check.

### `viewObject(qu, prefix, { createItem, render, key?, pattern? })` → `() => void`
One-way, eine Sammlung. Jeder QuBit direkt unter `prefix` (Default-Pattern
`${prefix}/*`, überschreibbar) bekommt einmalig `createItem(qubit)` (liefert
ein beliebiges opakes "Item", typischerweise ein bereits eingefügtes
DOM-Element) und danach bei jedem Update `render(item, value, qubit)`.
`key(qubit)` bestimmt die Item-Identität (Default: `qubit.id`). Gleiches
`(id, ts)`-Dedup pro Item wie `viewKey()`.

### `bindKey(qu, id, element, { get?, set?, event?, onError? })` → `() => void`
Two-way — derselbe Live-Render wie `viewKey()`, plus ein lokaler
Edit-Listener, der zurückschreibt. `get`/`set`/`event` defaulten auf
`<input>`/`<textarea>` (`.value`, Event `input`), sonst `.textContent`
(funktioniert für contenteditable).

Beide Hälften des Echo-Problems werden explizit geschützt, nie durch
pauschales Unterdrücken:
- **Schreib-Seite:** ein Edit, dessen Wert bereits dem bekannten lokalen
  Wert entspricht, wird nie publiziert.
- **Render-Seite:** das QuBit, das dieses Binding selbst gerade publiziert
  hat, wird nicht erneut gerendert (würde Cursor/Selektion überschreiben)
  — ein ANDERES Binding auf dieselbe `id` (anderer Tab, anderer Nutzer)
  rendert weiterhin normal.

Der `ts` des Publish wird vorab berechnet (`qu.runtime.nextTs()`) und mit
eingehenden QuBits verglichen, statt erst nach `await qu.publish()` — die
Runtime dispatcht synchron während `ingest()`, ein Vergleich erst nach
`await` würde das eigene erste Echo verpassen. `onError(e)` (optional) läuft
bei einem abgelehnten Write (z.B. ACL-Ablehnung); der Element-Wert wird dabei
auf den vorherigen Stand zurückgesetzt.

### `bindObject(qu, prefix, fields, opts?)` → `() => void`
Two-way, mehrere Felder eines Datensatzes: ein `bindKey()` pro Feld, jedes
Feld eine eigene Leaf-QuBit (`${prefix}/${field}`) — dieselbe "jedes Feld
seine eigene Leaf-QuBit"-Form wie `Qu.publishProfile()`, damit zwei
unabhängige Schreiber nie auf demselben LWW-Register kollidieren.
`fields`: `{ [feldname]: element }`.

```js
import { viewObject, bindKey } from './src/index.js';

const offList = viewObject(qu, `${qu.userSpaceId}/todos`, {
  createItem: (q) => document.querySelector('ul').appendChild(document.createElement('li')),
  render: (li, value) => { li.textContent = value.text; },
});

const input = document.querySelector('#note');
const offBind = bindKey(qu, `${qu.userSpaceId}/note`, input); // tippen schreibt sofort, kein Speichern-Knopf

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

`.qu` muss keine `Qu`-Instanz sein — ein `QuSpace` (`qu.own`/`qu.space(id)`)
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
auf `qu.space(<Item-Id>)` gesetzt, sodass `<qu-view>`/`<qu-bind>` INNERHALB
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
