# QU Framework — Architecture Whitepaper v0.6

> v0.1 beschrieb die Vision, v0.2 schloss die ersten Implementierungslücken
> (Zero-Trust, Sync-Pfad, Krypto), v0.3 ergänzte das Rechte-/
> Adressierungsmodell (Spaces), Referenzen und Netzwerkrand-Absicherung,
> v0.4 machte File-Handling zur getesteten Referenzimplementierung, v0.5
> ergänzte die `Qu`-Fassade, das Schreibmodell `publish` vs. `append` und
> das Chat-Modul. **v0.6** ergänzt einen optionalen Nachhol-Abruf für
> `on()` (`{ initial, once }`), einen pluggable `Router` für
> Transport-Auswahl bei mehreren Wegen zu einem Peer, WebRTC als weiteren
> `Channel`-Transport (Signaling über geroutete Events, kein Ersatz für den
> Relay), und die dritte Informationskategorie neben gespeicherten Daten
> und lokalen Events: geroutete, ephemere Punkt-zu-Punkt-Events. Validiert
> an `qu-core`, 93/93 Tests grün.
> **[v0.6]** markiert, was neu ist.

## 1. Vision

QU ist ein leichtgewichtiges, eventbasiertes Framework für lokale und
verteilte Anwendungen. Im Mittelpunkt stehen unveränderliche **QuBits**,
lokal gespeichert, über beliebige Transportwege synchronisiert, adressiert
innerhalb von **Spaces** und verarbeitet innerhalb von **Session**-Kontexten.

QU ist keine Datenbank, kein Netzwerkprotokoll, keine Anwendung. QU ist die
Runtime, die diese Komponenten verbindet.

## 2. Designziele

Kleiner Core · gut lesbarer, wartbarer, kommentierter Code · klare API für
Entwickler · modulare Architektur · offline-first · verteilte Synchronisation
· sichere Speicherung · kryptographisch überprüfbare Daten · Multiuser-fähig
· Transport- und Storage-unabhängig · wenige öffentliche APIs · Stabilität,
Skalierbarkeit, Performance · **Konsistenzgrad ist eine Anwendungsentscheidung,
kein Core-Versprechen**.

## 3. Grundprinzipien

| Prinzip | Bedeutung | Durchsetzung |
|---|---|---|
| **Immutable Data** | Ein QuBit wird nie verändert; Änderungen sind neue QuBits. | `QuStore.put()` akzeptiert nur `ts`-progressive Writes; gleich-`ts` = No-op, älter-`ts` wird verworfen. |
| **Event Driven** | Module kommunizieren ausschließlich über QuBits/Events. | `publish()` / `on()` / `emit()` sind die einzigen Kopplungspunkte. |
| **Session Isolation** | Benutzer existieren nicht im Core. | Identität lebt ausschließlich in `Session`-Instanzen (§7). |
| **Zero Trust** | Kein QuBit wird ungeprüft übernommen — lokal wie remote wie am Netzwerkrand. | Ein Schreibpfad (`ingest()`), Verify läuft immer (§6.4); Channel-Identität wird beim Verbindungsaufbau bewiesen, nicht angenommen (§6.6). |
| **Encrypted by Design** | Store speichert Ciphertext unverändert; Core sieht nie Klartext. | Ver-/Entschlüsselung passiert ausschließlich in `Session` (§7). |
| **Rechte sind an Spaces gebunden, nicht an Pfade oder Nachrichten** **[v0.3]** | Ein Manifest pro Space, nicht ein ACL-Eintrag pro Ordner oder Nachricht. | §8. |
| **Zwei Schreibmodi, keine Konvention** **[v0.5]** | `publish(id, ...)` = benanntes, veränderliches Register (LWW). `append(collectionId, ...)` = kollisionssicheres, nach Schreiber-Fingerprint partitioniertes Set — für Sammlungen mit mehreren unabhängigen Schreibern. | §7.2. |
| **Sync ist Mechanismus, kein Versprechen** | Core liefert Bausteine, nicht "perfekte" Konsistenz. | Replication ist austauschbares Modul (§10). |

## 4. Architektur

```
Facade                          Core                          Plugins                    Module
Qu  ─────────────────────────►  ├── QuBit (Datentyp, +refs)   ├── Storage-Adapter         ├── Replication
(komponiert Runtime+Store+                                     │   (Memory/IndexedDB/…)    │   (Provider + Hub)
 Session+Spaces+Module          ├── Runtime                    ├── File-Storage-Adapter    ├── Spaces
 hinter Instanz-Methoden,       │   ├── Pipeline               ├── Channel-Implementierung │   (ACL-Resolver)
 keine eigene Logik)             │   │   (Commit Engine)        │   (WebSocket/WebRTC/…)    ├── File-Handling
                                 │   ├── QuStore (Mounts)       ├── Verify-/ACL-Middleware  │   (Transfer)
                                 │   └── Dispatch /                                          ├── Chat
                                 │       Subscription Engine                                 │   (Räume, Anhänge)
                                 ├── Channel (Contract)                                       ├── Database
                                 │   └── Handshake                                             └── Ticketing …
                                 └── Session
                                     ├── Identity
                                     └── Crypto Provider
```

Module benutzen ausschließlich die öffentliche API von `Runtime`/`Session`
und besitzen keine Sonderrechte. **Spaces** ist selbst ein Modul **[v0.3]**
— Core kennt keine ACLs, nur eine generische `getACL(id)`-Middleware (§8,
§9); wie Rechte tatsächlich verwaltet werden, entscheidet dieses Modul.

**`Qu` ist eine vierte Schicht** **[v0.5]**, oberhalb von Core *und* Module
— sie komponiert beide für den Anwendungsfall, den die meisten Apps
tatsächlich brauchen, enthält aber selbst keine Logik, nur Verdrahtung
(siehe §12). Core kennt `Qu` nicht; `Qu` kennt Core und alle Module. Die
darunterliegenden Bausteine (`QuRuntime`, `QuSession`, einzelne Module)
bleiben für fortgeschrittene Fälle direkt nutzbar.

## 5. QuBit

```ts
interface QuBit {
  id: string;           // "<SpaceId>/<Unterpfad>" oder exakt "<SpaceId>" (Space-Manifest, §8)
  value: unknown;        // Nutzdaten oder EncryptedEnvelope (§7.2) — Core interpretiert value nie
  ts: number;             // HLC-Zeitstempel (§6.1)
  refs?: string[];         // [v0.3] Liste referenzierter QuBit-IDs — Listen, Anhänge, Space-Referenzen
  writer?: string;          // Fingerprint des Autors
  sig?: string;              // Signatur über canonical(...)
  pubKey?: JsonWebKey;        // Self-certifying Public Key (§6.4)
}

function canonical(q: QuBit): string {
  const v = typeof q.value === 'string' ? q.value : JSON.stringify(q.value);
  const r = JSON.stringify(q.refs ?? []);
  return `${q.id}|${v}|${q.ts}|${r}`;   // [v0.3] refs sind Teil der Signatur — sonst nachträglich austauschbar, ohne dass Verify es merkt
}
```

`refs` hat **keine** Sondersemantik im Core — es ist ein einfacher
Zeiger-Container. Anwendungsfälle:
- **Listen/Arrays:** Der häufige Fall braucht `refs` gar nicht — ein gemeinsamer
  Pfad-Präfix plus `query()`/`on('prefix/**')` IST bereits die Liste (z. B.
  alle Nachrichten eines Chatraums). `refs` lohnt sich für **kuratierte,
  cross-Space oder umsortierte** Sammlungen (z. B. "angeheftete Nachrichten",
  "meine favorisierten Spaces"), wo Reihenfolge/Auswahl nicht aus dem Präfix
  folgt.
- **Dateianhänge:** `refs: ["files/<fileId>"]` — kein eigenes Feld nötig (§11).
- **Space-Referenzen:** `refs: ["<spaceId>"]`, z. B. im Profil eines Users, um
  auf einen anderen Space zu verweisen (Inbox-Pattern, §8.4). Auflösung ist
  Anwendungssache (`Session.resolveRefs()`), keine automatische Reaktivität —
  Core bleibt ein dummer Store.

## 6. Core

### 6.1 Clock

HLC-artige Uhr liefert eine **totale Ordnung** für Last-Write-Wins, **keine**
Kausalitäts-/Vektoruhr-Garantie. Akzeptierter Trade-off (wie GunDBs HAM).

### 6.2 QuStore & Mounts

Persistiert exakt das übergebene QuBit; verändert, entschlüsselt,
interpretiert nichts. Auflösung nach längstem Mount-Prefix.

```ts
interface Mount { prefix: string; adapter: StorageAdapter; replicate?: boolean } // default true

interface StorageAdapter {
  get(id: string): Promise<QuBit | null>;
  put(id: string, q: QuBit): Promise<void>;
  delete(id: string): Promise<void>;
  getAll(prefix?: string): Promise<QuBit[]>;
}
```

Ein Mount konfiguriert **wo Bytes physisch liegen und ob sie das Gerät
verlassen dürfen** — nichts davon hat mit Zugriffsrechten zu tun (die sind an
Spaces gebunden, §8). Beide Konzepte sind bewusst orthogonal:

| Frage | Mechanismus |
|---|---|
| Wer darf lesen/schreiben? | Space + Manifest (§8) |
| Wo liegen die Bytes, wie lange, wie flüchtig? | Mount + `StorageAdapter` |
| Verlässt es je dieses Gerät? | Mount-Flag `replicate` |

**Persistenzstufen über denselben `StorageAdapter`-Contract, austauschbar
ohne Code-Änderung** — genau das macht Test-/Prod-Konfiguration zu einer
reinen Mount-Tabellen-Frage:

- **Nur Event-Bus:** `NullAdapter` — speichert nichts, `ingest()` dispatcht
  trotzdem ganz normal an `on()`. Für Presence, Tippindikatoren, Live-Ticker.
- **Memory:** `MemoryAdapter` — flüchtig, ideal für Tests (keine echte
  IndexedDB/Datei-I/O nötig).
- **Persistent:** `WebStorageAdapter` (localStorage/sessionStorage),
  IndexedDB-, Filesystem-, SQLite-Adapter — gleicher Contract, mechanische
  Fleißarbeit, kein Architekturrisiko.

Eine App im Test-Modus tauscht einfach die Mount-Tabelle (IndexedDB → Memory),
ohne dass Runtime, Session oder Anwendungscode sich ändern.

`isReplicable(id)` **[v0.3]** — prüft das `replicate`-Flag des zuständigen
Mounts; von jeder Replication-Implementierung als harte Schranke *vor* der
Space-ACL zu prüfen (§10).

### 6.3 Pipeline (Commit Engine) & Runtime

Ein einziger Schreibpfad: `ingest()`. Ob ein QuBit von einer lokalen `Session`
oder per Replication von einem Peer kommt, ist für den Core ununterscheidbar
— beides durchläuft dieselbe Verify-/ACL-Pipeline, ohne Sonderfall "ist ja
lokal".

```ts
interface QuRuntime {
  use(middleware: Middleware): this;
  ingest(qubit: QuBit): Promise<{ accepted: boolean; noop?: boolean; qubit: QuBit }>;
  publish(id: string, value: unknown, opts?: { ts?: number }): Promise<...>;
  get(id: string): Promise<QuBit | null>;
  query(pattern: string): Promise<QuBit[]>;
  on(pattern: string, cb: (q: QuBit) => void): () => void;
  emit(topic: string, payload?: object): void;   // ephemer, ungespeichert — z. B. "sync.complete"
  nextTs(): number;
  readonly store: QuStore;
}
```

### 6.4 Identity & Zero-Trust-Verify

`fingerprint = hash(publicSigningKey)` — per Konstruktion. Verify
rekonstruiert den Fingerprint aus dem mitgelieferten `pubKey` und verwirft
das QuBit bei Nichtübereinstimmung mit `writer`. Da SHA-256 preimage-resistent
ist, kann nur der tatsächliche Private-Key-Inhaber ein QuBit mit seinem
eigenen Fingerprint als `writer` erzeugen — Identitäts-Spoofing ist
kryptographisch ausgeschlossen, nicht nur unwahrscheinlich.

### 6.5 Dispatch / Subscription Engine

Segment-Trie (`*` = ein Segment, `**` = dieser Knoten + alles darunter) statt
linearem Scan. `publish()` läuft nur die matchenden Zweige ab.

**`on(pattern, callback, opts?)` — optionaler Nachhol-Abruf [v0.6].**
Ohne `opts`: rein zukunftsgerichtet, wie zuvor — nichts bereits
Gespeichertes wird zugestellt. Das ist weiterhin der Default, damit kein
bestehender Aufrufer betroffen ist. Mit `opts` lässt sich das verbreitete
"erst alles Vorhandene, dann nur Änderungen"-Muster direkt ausdrücken,
statt es bei jedem Aufrufer per Hand zusammenzusetzen:

- `{ initial: true }` — liefert zunächst alles aktuell Passende (sortiert
  nach `ts`), danach laufend nur noch Neues/Geändertes.
- `{ once: true }` — liefert alles aktuell Passende, dann nichts mehr;
  keine laufende Subscription (inhaltlich `query()`, aber über dasselbe
  Callback-Interface).

Der naive Aufbau — erst `query()`, dann `on()` — hat ein Race: ein QuBit,
das genau in der Lücke dazwischen eintrifft, wird entweder doppelt oder
gar nicht zugestellt. Die Implementierung (`core/subscribe-with-options.js`)
löst das über einen `id|ts`-Schlüsselabgleich des initialen Snapshots
gegen die ersten Live-Events, nicht über ein Zeitfenster oder eine Sperre.
`on()` selbst bleibt dabei synchron (liefert immer sofort eine
Unsubscribe-Funktion, auch während der interne Nachhol-Abruf noch läuft).

**Drei Kategorien von Information, nicht zwei [v0.6].** Mit den geroutet
Events (§10.4) wird die bisherige Zweiteilung "gespeichert vs. lokal
ephemer" um eine dritte, strukturell andere Kategorie ergänzt:

| Kategorie | Mechanismus | Gespeichert? | Ziel |
|---|---|---|---|
| Daten | `publish()`/`append()` | ja (außer NullAdapter-Mount) | alle Subscriber eines Topics |
| Lokales Event | `runtime.emit()` | nie | nur lokal, verlässt den Prozess nie |
| Geroutetes Event | `sendRoutedEvent()`/`onRoutedEvent()` | nie | genau ein Fingerprint, über einen Channel geroutet |

Alle drei laufen letztlich über denselben Dispatch-Mechanismus (`on()`
bzw. direkt über einen Channel), aber mit fundamental unterschiedlicher
Sichtbarkeit — welche Kategorie passt, ist eine Modellierungsentscheidung
pro Anwendungsfall, keine Präferenz.

### 6.6 Channel & Handshake **[v0.3: Zero-Trust jetzt auch am Netzwerkrand]**

```ts
interface Channel {
  readonly id: string;
  connect(): Promise<void>;
  send(message: object): Promise<void>;
  onMessage(handler: (msg: object) => void): () => void;
  onClose(handler: () => void): () => void;
  close(): Promise<void>;
}

function authenticateChannel(channel: Channel, identity: Identity | null): Promise<string | null>; // -> bewiesener Peer-Fingerprint
```

Vorher war `peerFingerprint` (für §9s `filterForReader`) eine reine
Konstruktor-Annahme — die Zero-Trust-Kette brach am Netzwerkrand ab.
`authenticateChannel()` ist eine gegenseitige Challenge-Response: jede Seite
signiert eine vom Gegenüber gewählte Zufallszahl mit derselben Identity, die
auch QuBits signiert, und die Prüfung nutzt dieselbe Fingerprint-Bindung wie
§6.4. Ein Channel-seitiger Identitätsanspruch wird also demselben Standard
unterworfen wie ein QuBit-`writer`-Anspruch, nicht einem schwächeren.

Der Contract selbst ist transportagnostisch — ein In-Process-Loopback (für
Tests), eine echte WebSocket-Verbindung und eine WebRTC-`RTCDataChannel`
(§10.5) erfüllen ihn identisch. Alles oberhalb (Replication, Files,
Handshake selbst) kennt nur diesen Contract, nie eine konkrete
Transport-API.

### 6.7 Space-Adressierung

```ts
type SpaceId = `~${string}` | string;  // "~<fingerprint>" (User-Space) | UUID (generischer Space)

function spaceIdOf(id: string): SpaceId;      // erstes Pfadsegment
function userSpaceId(fp: string): SpaceId;     // "~" + fp
function randomSpaceId(): SpaceId;              // crypto.randomUUID()
```

Jede QuBit-`id` liegt in genau einem Space (`<SpaceId>` selbst = Space-
Manifest, oder `<SpaceId>/<Unterpfad>` = Nutzdaten darin). Details zu Rechten
in §8.

## 7. Session

```ts
class QuSession {
  constructor(runtime: QuRuntime, opts?: { identity?: Identity; getACL?: GetACL });
  readonly fingerprint: string | null;
  publish(id: string, value: unknown, opts?: { ts?: number; encryptFor?: string[]; refs?: string[] }): Promise<...>;
  append(collectionId: string, value: unknown, opts?: { ts?: number; encryptFor?: string[]; refs?: string[] }): Promise<...>;   // [v0.5]
  get(id: string): Promise<QuBit | null>;
  query(pattern: string): Promise<QuBit[]>;
  on(pattern: string, cb: (q: QuBit) => void): () => void;
  trustPeer(fingerprint: string, encPubKeyJwk: JsonWebKey): Promise<void>;
  resolveRefs(qubit: QuBit): Promise<(QuBit | null)[]>;   // [v0.3]
}
```

### 7.1 Kapselung

Eine Session trägt ihre Identität **bei jedem Aufruf selbst**, registriert
nichts Globales auf der Runtime. Daraus folgt ohne Sonderfall: mehrere
Sessions können eine Runtime teilen (z. B. mehrere Nutzer auf einem
Server-Prozess), keine kann für eine andere signieren; eine Session kann
identitätslos sein (anonym/read-only).

### 7.2 Zwei Schreibmodi: `publish()` vs. `append()` **[v0.5]**

`publish(id, value)` ist ein benanntes, veränderliches Register (LWW,
Last-Write-Wins) — dieselbe `id` von zwei *verschiedenen* Schreibern
überschreibt sich gegenseitig. Das ist kein Sicherheitsproblem (beide
Signaturen sind echt, Verify greift normal), aber ein echter Datenverlust,
wenn die Anwendung eigentlich "viele unabhängige Beiträge zu einer
gemeinsamen Sammlung" meinte (Chat-Nachrichten, Kommentare,
Aktivitäts-Events) statt "eine benannte, veränderliche Stelle" (ein
Space-Manifest, ein Profilfeld).

`append(collectionId, value)` ist der zweite Modus dafür: er hängt
`/${identity.fingerprint}/${ts}` an `collectionId` an, **bevor** derselbe
`publish()`-Pfad läuft. Zwei verschiedene Schreiber können dadurch
strukturell nie auf derselben ID landen — nicht per Konvention, die jemand
befolgen oder vergessen könnte, sondern weil unterschiedliche Fingerprints
zwangsläufig unterschiedliche Pfade erzeugen. **Keine ACL-Sonderbehandlung
nötig:** `spaceIdOf(id)` (das erste Pfadsegment, §6.7) ist unverändert
dasselbe, ob die restliche ID von der Anwendung frei gewählt oder von
`append()` generiert wurde — Write-/Read-ACL prüfen exakt wie bei jedem
anderen QuBit.

Das ist die aus der CRDT-Theorie bekannte Unterscheidung zwischen einem
LWW-Register und einem (nach Schreiber partitionierten) Grow-Only-Set —
keine Chat-spezifische Erfindung, sondern ein generisches Session-Primitiv,
das jedes Modul mit Mehrschreiber-Sammlungen nutzen kann (Chat, §11a;
zukünftig Ticketing, Kommentare, Aktivitäts-Feeds).

**Wichtig, weil leicht falsch verstanden:** Der Fingerprint im Pfad ist
eine Adressierungs-Konvention zur Kollisionsvermeidung, **keine
Vertrauensquelle**. Ein böswilliger Schreiber kann einen Pfad konstruieren,
der wie der Namensraum eines anderen aussieht
(`.../msgs/<fremder-fingerprint>/...`) — das ändert nichts am signierten
`writer`-Feld des QuBits, das weiterhin unweigerlich den tatsächlichen
Autor zeigt. Jede Anwendung muss Autorschaft aus `writer` ableiten, nie aus
dem ID-Text.

### 7.3 Lokale Read-ACL ist opt-in

Zwei getrennte Prozesse/Geräte brauchen sie lokal nicht — die
Netzwerkgrenze filtert bereits (§9, zwingend). Teilen sich aber mehrere
Sessions eine Runtime im selben Prozess, filtert eine mit `getACL`
konstruierte Session auch ihre eigenen `get()`/`query()`-Ergebnisse —
dieselbe Prüfung, nur an der In-Process- statt der Netzwerkgrenze
angewendet. Core/Session bleiben dabei entkoppelt vom Spaces-Modul:
`getACL` ist nur eine generische Funktion, deren konkrete Implementierung
(§8) von außen hereingereicht wird.

### 7.4 Verschlüsselung

Unverändert seit v0.2: ECDH (ephemeral-static) → HKDF (domain-separiert je
Empfänger-Fingerprint) → AES-256-GCM, pro Empfänger. Ersetzt den rohen
XOR-Key-Wrap aus v0.1. Ein QuBit mit `value.__qu_enc === 1` ist für den
Core ein opakes Objekt; nicht-adressierte Sessions erhalten `undefined`,
keinen Fehler.

## 8. Spaces & Zugriffsrechte **[v0.3, ersetzt die frühere Pfad-für-Pfad-ACL]**

Rechte sind **ausschließlich an Spaces gebunden** — ein Manifest-QuBit pro
Space, kein Eintrag pro Unterordner, keiner pro Nachricht.

```ts
interface SpaceManifest {   // liegt als QuBit exakt bei id === SpaceId
  admins: string[];          // dürfen das Manifest selbst ändern
  writers: string[] | ['*'];
  readers: string[] | ['*'];
}

function createSpaceACLResolver(runtime: QuRuntime): GetACL;
function createSpace(session: QuSession, opts?: { writers?: string[]; readers?: string[]; admins?: string[] }): Promise<SpaceId>;
```

### 8.1 User-Space (`~<fingerprint>`)

Der Owner ist **strukturell immer Writer und Admin** — mit oder ohne
Manifest, und kein Manifest-Inhalt kann das aufheben. Ein Manifest kann
zusätzliche Writer *hinzufügen*, den Owner aber nie entfernen — man kann sich
nicht aus der eigenen Identität aussperren.

**Profil-Feldschema** **[v0.5, präzisiert]**: Kein zusammengesetztes
`~<fp>/profile`-Objekt — einzelne Felder direkt unter der Root, jedes ein
eigenes QuBit:

```
~<fp>            → Space-Manifest (admins/writers/readers) — reserviert, siehe oben
~<fp>/pub        → der Fingerprint selbst (redundant zur Adresse, aber explizit auffindbar)
~<fp>/alias      → Anzeigename
~<fp>/epub       → ECDH-Public-Key (JWK) — macht trustPeer() aus der Ferne möglich (§7.4)
~<fp>/links      → benannte Referenzen (z. B. { inbox: <spaceId> }, §8.4)
~<fp>/<beliebig> → strukturell weiterhin nur vom Owner beschreibbar
```

Einzelne Felder statt eines Objekts bedeutet: ein anderer Client kann
gezielt nur `~<fp>/epub` lesen/syncen, ohne den Rest des Profils zu
berühren, und eine `on('~<fp>/**')`-Subscription reagiert auf jede
Feldänderung einzeln.

### 8.2 Generischer Space (UUID)

Kein impliziter Owner. **Bootstrap-Regel:** Bevor ein Manifest existiert,
darf jeder schreiben (inklusive des ersten Manifests selbst — First-Write-
Wins). Sobald eines existiert, gilt es. Bekannte, akzeptierte v1-Einschränkung
(Race um den allerersten Schreibvorgang möglich); eine Reserve-Vorstufe wäre
eine spätere, rückwärtskompatible Ergänzung, keine Architekturänderung.

### 8.3 Manifest-Änderungen brauchen `admins`, nicht nur `writers`

Sonst könnte sich ein regulärer Writer eines Spaces selbst mehr Rechte
einräumen. Geprüft an `id === SpaceId` (das Manifest schreibt sich selbst an
seiner eigenen Space-Root).

### 8.4 Muster: Inbox = Space + Referenz, kein Framework-Konzept

Eine Inbox ist **kein** Core-Begriff — sie ist nur die Kombination zweier
vorhandener Dinge, per Konvention, komplett opt-in (nichts entsteht, bis eine
App es anlegt):

1. Ein normaler generischer Space mit `{ writers: ['*'], readers: [ownerFp] }`.
2. Eine Referenz vom Profil des Owners darauf: `~<ownerFp>/links` mit
   `{ inbox: <spaceId> }` (oder als `refs`).

Jeder darf in diesen Space schreiben (Struktur-ACL des Spaces), aber nur der
Owner darf lesen (Space-Readers) — zusätzlich typischerweise mit
`encryptFor: [ownerFp]` verschlüsselt, sodass selbst ein kompromittierter
Sync-Peer nur Ciphertext sieht. Auffindbarkeit läuft rein über die
Profil-Referenz, nicht über einen hartkodierten Pfad — ein Client liest
`~<ownerFp>/links`, folgt der Referenz, fertig.

Dasselbe Muster (Space + Referenz vom Profil) trägt jede Art von "gemeinsamem
Space" — ein Chatraum ist strukturell identisch, nur mit einer anderen
Writers-/Readers-Konfiguration im Manifest.

### 8.5 Read-Filterung ist nach Space gebündelt

`filterForReader(qubits, readerFingerprint, getACL)` gruppiert eingehende
Treffer nach `spaceIdOf(id)` und ruft `getACL` **einmal pro Space**, nicht
einmal pro QuBit — eine Sync-Antwort mit hundert Nachrichten aus einem
Chatraum kostet einen Manifest-Lookup, nicht hundert.

## 9. Sicherheitsmodell (Zero Trust) — Zusammenfassung

1. Identitäts-Spoofing ist kryptographisch ausgeschlossen (§6.4).
2. Verify läuft bei jedem `ingest()`, ohne Ausnahme für lokale Writes (§6.3).
3. Channel-Identität wird beim Verbindungsaufbau bewiesen, nicht angenommen (§6.6).
4. **Write-Rechte sind Space-gebunden** (§8), geprüft in der Commit-Pipeline,
   nach Verify.
5. **Read-ACL ist an der Sync-/Replication-Grenze zwingend** (§10) und lokal
   optional (§7) — beide Male dieselbe `filterForReader()`-Funktion, beide
   Male Space-gebündelt (§8.5).
6. Verschlüsselte Daten bleiben verschlüsselt, bis eine adressierte Session
   sie entschlüsselt (§7).
7. `replicate: false` auf einem Mount ist eine zweite, unabhängige Schranke
   vor der ACL — ein lokal-only-Pfad verlässt das Gerät nie, selbst bei einer
   offenen Read-ACL (§6.2, §10).

## 10. Replication ist ein Modul, kein Core-Bestandteil

> *"Der Core garantiert nicht die perfekte Synchronisation. Er garantiert
> die Mechanismen, mit denen Synchronisation implementiert werden kann."*

```ts
interface ReplicationProvider {
  sync(opts: { topic: string; since?: number }): Promise<number>;
  repair(opts: { topic: string; since?: number }): Promise<number>;
  snapshot(opts: { topic: string }): Promise<number>;
  listen(): void;
}
```

Jede Implementierung MUSS vor jedem Versand prüfen: `isReplicable(id)` (§6.2,
zuerst) **dann** `filterForReader()` (§8.5) — beides Teil des Contracts, nicht
der jeweiligen Strategie.

**Offline-Queue-Frage: es gibt keine separate Queue-Datenstruktur.** **[v0.3]**
Der Store selbst ist die Queue — jeder Offline-Write liegt sofort, dauerhaft,
adressierbar unter `(topic, ts)`. Was fehlte, war reine Choreographie:

- **Reziproker Sync** **[v0.3]**: Beantwortet eine Seite eine
  `sync`-Anfrage zu Topic T, stellt sie automatisch dieselbe Frage an den
  Anfragenden zurück (einmalig, gegen Endlosschleife durch ein
  `reciprocal: false`-Flag auf der Rück-Anfrage abgesichert). Ein einziger
  `sync()`-Aufruf beim Reconnect — von welcher Seite auch immer — leert damit
  beide Richtungen, inklusive dessen, was der Peer offline geschrieben hat.
- **Live-Push** **[v0.3]**: Neu eingegangene QuBits werden zusätzlich sofort
  an verbundene, berechtigte Peers gepusht (`pushTopics`-Option), statt nur
  beim nächsten `sync()` sichtbar zu werden. Ein kleiner, größenbeschränkter
  Anti-Echo-Cache vermeidet unnötiges Zurücksenden an den Absender — reine
  Effizienz, keine Korrektheitsanforderung (Store-Idempotenz macht ein Echo
  ohnehin harmlos).
- **`ReplicationHub`** **[v0.3]**: Ein Server-Knoten hat eine Runtime, aber
  viele Channels (einen pro verbundenem Client). Der Hub verwaltet eine
  `DefaultReplication`-Instanz pro Channel, führt vor jeder den Handshake
  (§6.6) aus, damit `peerFingerprint` nie eine Annahme, sondern immer ein
  Beweis ist.

**DefaultReplication** (mitgeliefert): Delta-Sync über `topic + since`,
`repair()` mit überlappendem Zeitfenster. Dedup ist keine Extra-Logik,
sondern eine Store-Eigenschaft (§3). Weitergehende Strategien
(`MerkleReplication`, `BloomReplication`, `EnterpriseReplication`)
implementieren denselben Contract, austauschbar ohne Core- oder
Anwendungsänderung.

```
Initial Sync → Delta Sync → Repair → Ready
Reconnect    → Delta Sync (reziprok) → Repair → Continue
```

### 10.1 Subscription vs. Routing — zwei verschiedene Fragen, keine Alternative **[v0.6]**

Eine wiederkehrende Design-Frage: sollte QU auf **aktivem Routing** beruhen
(der Schreiber entscheidet, wohin ein QuBit geschickt wird) oder auf
**Subscription** (der Empfänger erklärt, was er will, und bekommt es)? Die
Antwort ist: beides, weil sie unterschiedliche Fragen beantworten.

- **Subscription beantwortet: WELCHE Themen will ein bestimmter, verbundener
  Peer überhaupt?** Das ist `pushTopics` — statisch bei `connect()` gesetzt,
  seit v0.3. Ein verbundener Peer bekommt genau das, was für ihn
  konfiguriert wurde, nicht mehr.
- **Routing beantwortet: ÜBER WELCHEN KANAL erreiche ich einen Peer, wenn es
  mehrere Wege gibt?** Das ist der `Router` (§10.2) — er trifft diese
  Entscheidung erst, NACHDEM feststeht, dass ein QuBit für ein Topic
  überhaupt gesendet werden soll.

Beide Schichten sind unabhängig austauschbar: `pushTopics` könnte später um
eine dynamische, laufzeitveränderliche Subscription erweitert werden (eine
`qu.subscribe`/`qu.unsubscribe`-Nachricht über einen bestehenden Channel,
statt die Interessen nur einmalig beim Verbindungsaufbau festzulegen) —
das würde die Router-Schicht überhaupt nicht berühren, weil sie eine Ebene
darüber sitzt.

### 10.2 Router: welcher Kanal, wenn mehrere existieren **[v0.6]**

```ts
interface Route {
  channelId: string;
  channel: Channel;
  pushTopics: string[];
  role: 'mirror' | 'sync';
  group?: string | null;   // nur bei role: 'sync' relevant
  metric?: number;          // niedriger = bevorzugt
  peerFingerprint?: string | null;
}

class Router {
  addRoute(route: Route): void;
  removeRoute(channelId: string): void;
  updateMetric(channelId: string, metric: number): void;
  resolve(qubit: QuBit): Route[];       // welche Kanäle bekommen dieses QuBit jetzt?
  isChosen(channelId: string, qubit: QuBit): boolean;
}
```

Zwei Rollen, bewusst unterschiedlich behandelt:

- **`role: 'mirror'`** — bekommt *immer* alles Passende, unabhängig von
  jeder anderen Route. Siehe §10.3: das ist die Storage-Relay-Verbindung
  eines Knotens, und Datenverlust durch eine "cleverere" Routing-
  Entscheidung ist ein Bug, keine Optimierung.
- **`role: 'sync'`** — konkurriert *nur* innerhalb einer explizit gesetzten
  `group` nach `metric` (niedriger gewinnt; Gleichstand → alle Routen der
  Gruppe). Ohne `group` (Standard) wird eine Sync-Route nie als Alternative
  zu einer anderen behandelt — beide werden unabhängig genutzt. Das ist
  eine bewusste Sicherheitsentscheidung: das automatische SCHLIESSEN einer
  Route, weil eine andere zufällig dasselbe Topic bedient, wäre ein
  stiller Datenverlust, wenn die Vermutung falsch war. Optimierung ist
  damit *opt-in* (die Anwendung setzt bewusst dieselbe `group` für zwei
  Kanäle, die sie als echte Alternativen zueinander versteht), nicht etwas,
  das der Router aus der Konfiguration errät.

`DefaultReplication` konsultiert den Router (falls vorhanden) unmittelbar
vor jedem Push (`isChosen(channelId, qubit)`); ohne Router unverändertes
Verhalten — die Integration ist rein additiv (§10 Encoding-Kompatibilität).
Der Router selbst kennt weder Relay noch WebRTC noch irgendeinen Transport
— reine Metrik-/Gruppen-Logik über abstrakte `Route`-Einträge. Eine andere
Routing-Strategie (z. B. laufzeitgemessene Latenz statt statischer Metrik,
oder ein DHT-gestütztes Discovery) ersetzt diese Klasse vollständig, ohne
Replication, Files oder irgendeine Anwendung anzufassen.

### 10.3 Der Storage-Relay ist ein Mirror, kein Peer unter vielen **[v0.6]**

Ein Knoten repliziert alles, was er selbst schreibt, **bedingungslos** zu
seinem designierten Storage-Relay — das ist die praktische Bedeutung von
"Relay als Backup", nicht nur eine Persistenzoption des Relays selbst
(§6.2 zeigt bereits, dass Storage-Adapter frei wählbar sind; hier geht es
um die Verbindungs-*Rolle*, nicht den Adapter). Diese Beziehung ist
1:1 (ein Knoten, sein eigener Autor-Content, sein Mirror) und **darf durch
keine Routing-Optimierung je unterlaufen werden** — eine direkte
WebRTC-Verbindung zu einem anderen Peer ist eine ZUSÄTZLICHE Möglichkeit,
Daten *diesem Peer* schneller zukommen zu lassen, niemals ein Ersatz für
die eigene Datensicherung. Modelliert wird das exakt durch `role: 'mirror'`
(§10.2) — kein Sonderfall in Replication, sondern dieselbe Router-
Abstraktion, nur mit der Garantie "immer gewählt".

Für Datei-Chunks gilt dasselbe Prinzip bereits seit §11, nur in
umgekehrter Blickrichtung: der Relay zieht sich Chunks **immer vom
ursprünglichen Autor/Uploader**, nie über einen dritten Peer geroutet
(`relay/relay.mjs`s `runtime.on('*/files/**')`-Handler verfolgt genau den
verbundenen Schreiber, nicht irgendeinen Besitzer der Datei). Für normale
QuBits ist kein äquivalenter Pull-Mechanismus nötig — Push-Replication mit
einer `role: 'mirror'`-Route erledigt das strukturell bereits: der Autor
schickt seine Schreibvorgänge direkt und bedingungslos an seinen Mirror,
ohne dass der Mirror aktiv nachfragen müsste.

### 10.4 Geroutete Events — die dritte Kategorie **[v0.6]**

Siehe §6.5 für die Einordnung. `core/routed-events.js`:

```ts
function sendRoutedEvent(channel: Channel, toFingerprint: string, event: string, payload: object): Promise<void>;
function onRoutedEvent(channel: Channel, event: string, callback: (msg) => void): () => void;
```

Envelope: `{ type: 'qu.route', to, from, event, payload }`. Zentrale
Eigenschaften, die diese Kategorie von §7.2s Schreibmodi unterscheiden:

- **Nie gespeichert.** Läuft nie durch `runtime.ingest()` — kein `id`, kein
  `ts`, keine Signatur, kein Verify/ACL-Schritt. Strukturell nicht
  abfragbar, nicht replizierbar, nicht wiederherstellbar nach einem
  Neustart. Das ist Absicht, nicht eine fehlende Funktion.
- **Geroutet, nicht broadcastet.** Genau ein `to`-Fingerprint, nicht "alle
  Subscriber eines Topics". Ein Relay, der diese Nachrichten weiterleitet
  (`relay/relay.mjs`), tut das rein nach Fingerprint — dieselbe
  `connected`-Map, die bereits für Datei-Mirroring existiert — und
  überschreibt `from` immer mit der per Handshake bewiesenen Identität
  der Verbindung, nie mit einer Behauptung im Nachrichteninhalt. Ein
  unbekannter/nicht verbundener `to`-Fingerprint führt zu stillem
  Verwerfen, nicht zu einem Fehler an den Absender (kein Informationsleck
  über wer online ist).
- **`event` ist generisch, kein fest verdrahteter Typ.** Der Relay
  interpretiert `event`/`payload` nie — WebRTC-Signaling (§10.5) ist die
  erste, aber keineswegs einzige denkbare Nutzung. Ein Anruf-Invite, ein an
  eine bestimmte Person statt einen ganzen Raum gerichteter
  Tippindikator — jede punkt-zu-punkt-ephemere Kommunikation gehört
  hierher, nicht in `publish()`/`append()` mit einem `NullAdapter`-Mount
  (§6.2), weil letzteres weiterhin an *alle* Subscriber eines Topics
  broadcastet, nicht an einen einzelnen Empfänger geroutet.

### 10.5 WebRTC als weiterer Transport, kein Relay-Ersatz **[v0.6]**

WebRTCs Datenkanal erfüllt denselben `Channel`-Contract (§6.6) wie jede
andere Transport-Implementierung — `src/network/transports/webrtc-browser.js`
(minimal: nur Datenkanal, kein Audio/Video darin verdrahtet) macht dadurch
DefaultReplication, DefaultFileTransfer und den Handshake selbst
transportblind: keiner dieser Bausteine musste geändert werden.

**Signaling läuft über einen bestehenden Channel** (typischerweise die
Relay-Verbindung), nutzt `sendRoutedEvent`/`onRoutedEvent` (§10.4) mit
`event: 'webrtc-signal'` — SDP-Offer/Answer und ICE-Kandidaten sind
Nutzlast eines gerouteten Events wie jedes andere, kein WebRTC-Sonderpfad
im Relay. Verhandlungsmuster: "Perfect Negotiation" (deterministisch
"polite"/"impolite" aus dem lexikographischen Vergleich beider
Fingerprints abgeleitet, keine Koordinationsnachricht nötig).

**Sicherheitskritischer Schritt nach Verbindungsaufbau:** WebRTC/DTLS
verschlüsselt den Kanal, beweist aber keine Identität der Gegenseite. Der
`PeerConnectionManager` (`src/network/webrtc-peer-manager.js`)
führt deshalb **denselben Handshake wie jeder andere Channel** (§6.6) über
den neuen Datenkanal erneut aus, bevor die Verbindung für Replication
freigegeben wird — der Fingerprint, mit dem verbunden werden sollte, und
der tatsächlich bewiesene müssen übereinstimmen. Erst danach wird die
Verbindung (optional) beim `Router` registriert (`role: 'sync'`, meist
gruppiert mit der Relay-Route zum selben Peer, sodass beide um `metric`
konkurrieren, §10.2).

**Primärer Anwendungsfall: Weg zu einer Node ohne Relay** — Ausfall oder
bewusst gewünschte Direktverbindung, nicht ein genereller Ersatz für
Räume mit vielen Teilnehmern (die bleiben sinnvoll relay-vermittelt, schon
weil "Broadcast an alle Subscriber" strukturell ein Stern-, kein
Vollvermaschungs-Problem ist). Audio/Video ist als Erweiterung auf
derselben `RTCPeerConnection` vorgesehen (zusätzliche Media-Tracks statt
einer zweiten Verbindung pro Medientyp) — siehe `archive/examples/04-webrtc.html` (archiviert) bzw. das interaktive Lab (`docs/lab/`) für ein gepflegtes Netzwerk-Beispiel
für ein minimales, kommentiertes Beispiel.

## 11. File-Handling — Modul, referenzimplementiert **[v0.4]**

Eine Datei ist **kein** einzelnes QuBit — ein 200-MB-Video als ein
unveränderliches QuBit würde jede Query/jeden Sync-Response mitschleppen.
Trennung in zwei unabhängige Abstraktionen, beide optional, beide mitgeliefert,
beide reine Module (keine Core-Änderung):

**a) Speicherung** — eigener, von `StorageAdapter` getrennter Contract,
content-adressiert:

```ts
interface FileStorageAdapter {
  putChunk(hash: string, bytes: Uint8Array): Promise<void>;
  getChunk(hash: string): Promise<Uint8Array | null>;
  hasChunk(hash: string): Promise<boolean>;
  deleteChunk(hash: string): Promise<void>;
}
```

Content-Adressierung liefert Deduplizierung und Integritätsprüfung ohne
Signatur pro Chunk gratis — und zwar nicht nur zwischen Dateien, sondern
auch **innerhalb** einer Datei: zwei inhaltsgleiche Chunks erhalten denselben
Hash und werden nur einmal übertragen/gespeichert. Referenzimplementierung
bestätigt das (Testfall mit sich wiederholenden Bytes wurde initial für einen
Bug gehalten — war korrektes Verhalten, Test war falsch parametrisiert).

**b) Übertragung & Sync** — auf demselben `Channel`-Contract wie Replication:

```ts
interface FileManifest { name: string; mime: string; size: number; chunkSize: number; chunks: string[] } // id frei wählbar, meist "<Space>/files/<fileId>"

interface FileTransferProvider {
  requestFile(manifestId: string): Promise<void>;
  hasComplete(manifestId: string): Promise<boolean>;
}
```

`DefaultFileTransfer`: Das Manifest ist ein ganz normales QuBit — liegt es
lokal schon vor (z. B. durch Replication bereits gesynct), wird es direkt
gelesen; sonst per Anfrage geholt und **durch denselben `runtime.ingest()`-
Pfad** wie jedes andere QuBit verarbeitet (Verify + Space-ACL gelten
unverändert, kein Sonderfall für Dateien). Anschließend Diff zwischen
`manifest.chunks` und lokalem `FileStorageAdapter`, nur fehlende Chunks
anfordern; jeder empfangene Chunk wird gehasht und gegen den angefragten
Hash geprüft, bevor er gespeichert wird — ein Mismatch wird verworfen, nie
persistiert. Ein abgebrochener Transfer ist beim erneuten Aufruf nur ein
erneuter Diff — dieselbe "Store ist die Queue"-Philosophie wie bei
Daten-Sync (§10), auf Chunk-Ebene.

Ein Dateianhang an einem Chat-QuBit ist einfach `refs: ["<manifestId>"]`
(§5) — kein Sonderfeld.

## 12. Qu — Facade **[v0.5]**

Die meisten Anwendungen sollen nicht Runtime, Store, Session und
ACL-Resolver von Hand zusammensetzen müssen. `Qu` komponiert das — eine
vierte Schicht oberhalb von Core *und* Modulen (§4), selbst ohne eigene
Logik, nur Verdrahtung. Core kennt `Qu` nicht.

```ts
class Qu {
  static create(opts?: {
    identity?: Identity | ExportedKeys;
    guest?: boolean;
    runtime?: QuRuntime;
    store?: QuStore;
  }): Promise<Qu>;
  constructor(opts: { runtime: QuRuntime; store?: QuStore; identity?: Identity; guest?: boolean; acl?: GetACL });

  readonly fingerprint: string | null;
  readonly userSpaceId: string | null;
  readonly isGuest: boolean;
  exportKeys(): Promise<ExportedKeys | null>;

  publish(id, value, opts?): Promise<...>;
  append(collectionId, value, opts?): Promise<...>;          // §7.2
  get(id): Promise<QuBit | null>;
  query(pattern): Promise<QuBit[]>;
  on(pattern, cb): () => void;
  resolveRefs(qubit): Promise<(QuBit | null)[]>;
  trustPeer(fingerprint, encPubJwk): Promise<void>;

  publishProfile(opts: { alias?, epub?, ...rest }): Promise<void>;  // §8.1-Feldschema
  readProfile(fingerprint): Promise<{ alias, pub, epub }>;

  createSpace(opts?): Promise<SpaceId>;
  connect(channel, opts?: { pushTopics?: string[] }): Promise<DefaultReplication>;
  shareFile(id, bytes, opts): Promise<...>;
  fileTransfer(channel, fileStorage): DefaultFileTransfer;
  createChatRoom(memberFingerprints, opts?): Promise<SpaceId>;
  sendMessage(spaceId, opts): Promise<...>;
  listMessages(spaceId): Promise<QuBit[]>;
  onMessage(spaceId, cb): () => void;

  readonly runtime: QuRuntime;   // Fluchttür für fortgeschrittene Fälle
}
```

**Drei Wege zu einer Identität**, alle über den einen async Fabrikaufruf
(Schlüsselerzeugung ist inhärent async):

- `Qu.create()` — erzeugt eine neue Identität.
- `Qu.create({ identity })` — mit einer bestehenden `Identity`-Instanz oder
  zuvor exportierten Schlüsseln (`{signPub, signPriv, encPub, encPriv}`) —
  für persistente Identitäten über Neustarts hinweg.
- `Qu.create({ guest: true })` — erzeugt trotzdem eine echte, temporäre
  Identität (lesbar, adressierbar, kann Empfänger einer Verschlüsselung
  sein), aber **jede Schreib-Methode lehnt sofort ab**, unabhängig davon,
  was die Ziel-Space-ACL erlauben würde. Das ist eine harte Garantie auf
  Fassaden-Ebene, keine, die zufällig aus der jeweiligen ACL-Konfiguration
  folgt — ein Space mit `writers: ['*']` würde einen anonymen Write sonst
  durchlassen.

**Mehrere `Qu`-Instanzen können eine Runtime teilen**
(`Qu.create({ runtime: alice.runtime })`) — das deckt den
Mehrere-Sessions-eine-Runtime-Fall aus §7.1 ab, jetzt eine Zeile statt
manuellem Verdrahten. Verify-/ACL-Middleware wird pro Runtime-Instanz nur
einmal registriert (ein `WeakSet` verhindert Doppel-Registrierung), auch
wenn mehrere `Qu.create()`-Aufrufe dieselbe Runtime teilen.

Replication und Files bleiben Module (§10, §11) — `qu.connect()`/
`qu.shareFile()` sind bequeme Wrapper, keine neue Logik. `qu.runtime` ist
die Fluchttür für alles, was die Fassade nicht abdeckt.

## 13. Chat-Modul **[v0.5]**

Ein Raum (1:1 oder Gruppe — kein Unterschied im Modell, nur die
Mitgliederliste im Manifest) ist ein gewöhnlicher Space (§8). Das Modul
trägt selbst keine Sicherheitslogik bei — Kollisionssicherheit kommt
vollständig aus `append()` (§7.2); hier steht nur Namensgebung und
Anhang-Behandlung obendrauf, als Beleg dafür, dass `append()` tatsächlich
ein generisches Session-Primitiv ist und keine Chat-spezifische Erfindung.

```ts
function createChatRoom(qu: Qu, memberFingerprints: string[], opts?: { readers?: string[] }): Promise<SpaceId>;
function sendMessage(qu: Qu, spaceId: SpaceId, opts: {
  text: string;
  attachments?: { bytes: Uint8Array; name: string; mime: string; fileStorage: FileStorageAdapter }[];
  encryptFor?: string[];
}): Promise<...>;
function listMessages(qu: Qu, spaceId: SpaceId): Promise<QuBit[]>;   // älteste zuerst
function onMessage(qu: Qu, spaceId: SpaceId, cb: (q: QuBit) => void): () => void;
```

Ein Anhang (Bild, Video, beliebige Datei) ist ein eigenes File-Manifest
(§11), kollisionssicher adressiert wie die Nachricht selbst, per `refs`
verknüpft — Foto und Video unterscheiden sich nur im `mime`-Feld, keine
separate Behandlung.

`sendMessage()` ruft intern `qu.append(\`${spaceId}/msgs\`, {text}, {refs})`
auf — die ID einer Nachricht enthält den Fingerprint des Schreibers nur zur
Kollisionsvermeidung (§7.2), **nicht** als Vertrauensquelle. Eine
Chat-Oberfläche muss Autorschaft immer aus dem geprüften `writer`-Feld der
Nachricht ableiten, nie aus dem Pfad-Text.

## 14. Node

Jede Node (Browser, Server, Desktop, Mobile, Edge) besitzt Runtime + Store +
Dispatch identisch. "Keine Sonderrolle für Server/Client" gilt auf
Architekturebene; ein konkretes Channel-Plugin kann trotzdem asymmetrisch
sein (reiner WebSocket-Client kann nur ausgehend verbinden) — Symmetrie ist
eine Eigenschaft des gewählten Channel-Plugins, keine Core-Garantie.

## 15. Architekturprinzipien (Kurzfassung)

Kleiner Core · ein Schreibpfad · wenige öffentliche APIs · unveränderliche
Daten · ereignisgetrieben · Fingerprint = hash(pubKey) · **Rechte sind an
Spaces gebunden, nicht an Pfade** · Manifest-Änderung braucht Admin, nicht
nur Writer · Read-ACL ist an der Sync-Grenze zwingend, lokal optional, immer
Space-gebündelt · Channel-Identität wird beim Handshake bewiesen · Store ist
die Offline-Queue, keine separate Datenstruktur · Sync ist reziprok und
Modul, nicht Core · Session trägt Identität pro Aufruf, nie global · Core
sieht nie Klartext · Mounts (Storage) und Spaces (Rechte) sind orthogonal ·
File-Handling ist optionales Modul, Speicherung und Transfer getrennt ·
**`publish` (LWW-Register) und `append` (kollisionssicheres, nach Schreiber
partitioniertes Set) sind getrennte Schreibmodi, keine Konvention** ·
**Pfad-Fingerprints sind Adressierung, nie Vertrauensquelle — Autorschaft
kommt ausschließlich aus dem geprüften `writer`-Feld** ·
**`Qu` komponiert Core+Module hinter Instanz-Methoden, enthält selbst keine
Logik** · offline-first · transport- und speicherunabhängig · identische
Node-Architektur, austauschbare Channel-Symmetrie.

## Anhang A — Referenzimplementierung

`qu-core/` (ESM, Web Crypto API, Node 22 / moderner Browser, keine externen
Laufzeit-Abhängigkeiten):

```
core/       clock · identity · pipeline · store · subscriptions · runtime ·
             channel · handshake · session (publish+append) · space · bytes
crypto/     encrypt.js
plugins/    verify.js · acl.js · sign.js (canonical, inkl. refs)
modules/    replication/{provider,default,hub}.js · spaces.js ·
             files/{manifest,transfer}.js · chat.js
adapters/   memory.js · null.js · file-storage-memory.js
qu.js       Facade — komponiert alles Obige hinter Qu.create()/Instanz-Methoden
test/       *.test.mjs (node:test) — 36 Fälle, CLI und Browser-Shim geprüft
```

Geprüft u. a.: Trie-Routing, Spoofing-Schutz, Tamper-Detection (inkl. `refs`),
Multi-Session-Isolation, Encryption-Round-Trip, Read-ACL-gefilterte
Replication, Repair-Idempotenz, reziproker Sync (Offline-Writes ohne
Extra-Queue), Live-Push ohne Echo, Channel-Handshake, `replicate:false`-
Durchsetzung, Event-Bus-Mounts, User-Space-Bootstrap & Lockout-Schutz,
generischer Space-Bootstrap, Admin-vs-Writer-Trennung, Inbox-als-Space-Muster,
File-Handling (Zero-Trust-Manifest-Ingest, exakte Reassemblierung, Resume
mit Diff, Chunk-Hash-Ablehnung), **[v0.5]** `Qu`-Fassade (Guest-Schreibsperre,
Runtime-Sharing ohne Doppel-Middleware, Identitäts-Re-Import), `append()`-
Kollisionssicherheit auch bei identischem Zeitstempel, Chat-Modul (1:1,
Gruppe, Bild-Anhang-Rundlauf).

Noch offen: IndexedDB-/Filesystem-/SQLite-`StorageAdapter` (mechanisch, kein
Architekturrisiko); dieselben Adaptertypen für `FileStorageAdapter`.

## Anhang B — Für Codegenerierung

Alle Contracts in §5, §6.2, §6.3, §6.4, §6.6, §6.7, §7, §8, §10, §11, §12,
§13 sind bewusst als TypeScript-artige Interfaces notiert, nicht nur als
Prosa — Ausgangspunkt für mechanische Ableitung, auch in andere Sprachen.
§11 ist gegen eine echte Implementierung validiert, nicht nur entworfen.
Jede zukünftige Whitepaper-Änderung sollte primär diese Interfaces anfassen;
Prosa drumherum ist Begründung, nicht Spezifikation.
