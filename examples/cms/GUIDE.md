# QuCMS als universelle Space-App-Basis

Diese Datei beantwortet vier Fragen, die beim Bauen von `examples/cms-lib.mjs`
aufkamen: wie groß eine universelle Inhaltsverwaltung für QU tatsächlich sein
muss, wie man eine Site von komplett leer aus befüllt, ob es sinnvoll ist,
Doku/Beispiele selbst darüber auszuliefern, und wie man reaktives JavaScript
in ihre Inhalte bekommt. Code-Referenzen sind exakte Pfade in diesem Repo,
keine Pseudocode-Skizzen.

## 1. Die Bausteine — und wie groß sie wirklich sind

Zwei Schichten, nicht eine:

```
examples/space-app-lib.mjs      100 Zeilen  Nutzerverwaltung (ACL) + Navigations-Parsing — pure, node-testbar
examples/space-app-browser.js    62 Zeilen  Identity-Bootstrap, Relay-URL, Hash-Watching — browser-only
examples/cms-lib.mjs            173 Zeilen  Config/Templates/Seiten/Menü/Präsentationsmodus — pure, node-testbar
examples/cms-router.js          103 Zeilen  lokal- vs. präsentations-Routing — browser-only
```

Das sind zusammen **438 Zeilen**, davon ein erheblicher Teil Kommentare (Repo-
Konvention: das WARUM dokumentieren, nicht nur das WAS) — der tatsächliche
Code ist eher die Hälfte. Zum Vergleich: `examples/todo-lib.mjs` hat 72
Zeilen, `examples/forum-lib.mjs` 62. Ein "CMS-Plugin" für QU ist also keine
neue Kategorie von Komplexität, sondern derselbe Maßstab wie jede andere
Space-App — nur mit fünf statt einer Sorte Inhalt unter einem Space.

**Warum zwei Schichten, kein Monolith:** `space-app-lib.mjs`/`-browser.js`
sind bewusst UNIVERSELL — Nutzer hinzufügen/entfernen und "welcher Space,
welcher Pfad" (`#spaceId/pfad`) sehen für ToDo-Liste, Forum-Board und
CMS-Site identisch aus. `cms-lib.mjs`/`cms-router.js` sind dagegen bewusst
CMS-SPEZIFISCH (Config/Templates/Seiten/Präsentationsmodus) — sie bauen auf
der Shell auf, ersetzen aber NICHT `todo-lib.mjs`/`forum-lib.mjs`. Ein
gemeinsames "Content"-Schema für alle drei würde ihre bewusst
unterschiedlichen Schreibmuster verwässern (ToDo: `set()` + Tombstone-Delete;
Forum: `set()` + Zeit-Sharding gegen unbegrenztes Wachstum; CMS-Seiten:
`put()` pro Slug, ganze Seite auf einmal von einer Person editiert) — siehe
den Moduldoku-Kommentar in `space-app-lib.mjs` für die ausführliche
Begründung. Die Shell ist der Beweis, dass sich der gemeinsame Teil sauber
herauslösen lässt, ohne diesen Unterschied zu verlieren:
`examples/forum/app.mjs` und `examples/cms/app.mjs` nutzen beide dieselbe
`loadOrCreateIdentity()`/`relayUrl()`/`#spaceId/pfad`-Navigation, aber jede
Content-Lib bleibt ihrem eigenen Schreibmuster treu.

## 2. Von Null: eine Site ohne Content und ohne Templates befüllen

`createSite()` legt einen Space mit Manifest UND einer Basis-Konfiguration
an (`cms/config`, `cms/state/route`) — bewusst NICHT völlig leer, aus
demselben Grund wie in `cms-lib.mjs`s Doku zu `createSite()` erklärt: `on()`
liefert ohne existierenden Wert keine initiale Zustellung, ein komplett
leerer Space würde jeden späteren Client auf unbestimmte Zeit "Lädt …"
zeigen. **Aber Templates und Seiten (`cms/templates/*`, `cms/pages/*`) bleiben
absichtlich leer** — das ist der tatsächliche "Von Null"-Zustand:

```js
import { Qu, createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from '../../src/index.js';
import { createSite, onConfig, onPage } from '../cms-lib.mjs';

const qu = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
const channel = createWebSocketChannel('ws://localhost:8787/relay');
await channel.connect();

// Space + Basis-Config, aber NOCH KEIN Template, KEINE Seite:
const siteId = await createSite(qu, { title: 'Meine neue Site', writers: [qu.fingerprint] });
const repl = await qu.connect(channel, { pushTopics: [`${siteId}/`] });
await repl.sync({ topic: siteId, since: 0 }); // siehe Abschnitt 5 unten — sonst bleibt der Relay leer
console.log('Site erzeugt:', siteId, '— noch ohne Template/Seiten');
```

Ein Bootloader mit **komplett leerem `<body>`** (das PDF-Konzept aus der
ursprünglichen Machbarkeitsstudie, hier mit der echten statt einer
Mock-Store-API) rendert für genau diesen Zustand einen Einrichtungshinweis
statt eines Fehlers:

```html
<!-- index.html: leerer Body, alles kommt aus dem Store -->
<body></body>
<script type="module">
  import { Qu, createNetworkPlugin, createSpacesPlugin, createWebSocketChannel } from '/src/index.js';
  import { onConfig, onPage } from '/examples/cms-lib.mjs';

  const qu = (await Qu.create()).use(createNetworkPlugin()).use(createSpacesPlugin());
  const channel = createWebSocketChannel('ws://' + location.host + '/relay');
  await channel.connect();
  const siteId = new URLSearchParams(location.search).get('space');
  await qu.connect(channel, { pushTopics: [`${siteId}/`] });

  onConfig(qu, siteId, (q) => {
    if (!q?.value) {
      document.body.innerHTML = '<p>Diese Site hat noch keine Konfiguration — mit createSite() anlegen.</p>';
      return;
    }
    document.title = q.value.title;
    onPage(qu, siteId, 'home', (p) => {
      document.body.innerHTML = p?.value
        ? `<h1>${p.value.title}</h1><div>${p.value.blocks?.body ?? ''}</div>`
        : '<p>Diese Site hat noch keine Startseite — mit setPage() anlegen.</p>';
    });
  });
</script>
```

Ein Admin befüllt danach live — per Editor (siehe `examples/cms/app.mjs`s
"Seite bearbeiten"-Box) ODER direkt über die Browser-Konsole, genau wie in
`docs/playground.html` vorgemacht:

```js
// In der Konsole, mit einer bereits verbundenen `qu`-Instanz:
await setTemplate(qu, siteId, 'default', '<h1>{{title}}</h1><div>{{body}}</div>');
await setPage(qu, siteId, 'home', { title: 'Willkommen', blocks: { body: 'Erster Inhalt.' } });
await addNavItem(qu, siteId, { label: 'Start', slug: 'home', order: 1 });
```

Jeder bereits offene Client (der obige Bootloader eingeschlossen) aktualisiert
sich dabei live, ohne Reload — dieselbe Reaktivität, die `onConfig()`/
`onPage()` überall sonst im CMS liefern.

## 3. Als Basis für ToDo/Forum/Blog

Nicht durch ein gemeinsames Content-Schema (siehe Abschnitt 1), sondern
dadurch, dass jede App dieselbe Shell importiert. `examples/forum/app.mjs`
tut das bereits real (nicht nur als Konzept):

```js
import { loadOrCreateIdentity, relayUrl } from '../space-app-browser.js';
import { parseHashRoute, buildHashRoute } from '../space-app-lib.mjs';
// ... plus die eigene Content-Lib, hier forum-lib.mjs statt cms-lib.mjs
```

Ein Blog wäre technisch der nächstliegende Fall — praktisch `cms-lib.mjs`
selbst mit einer anderen Navigations-Konvention (Slugs als Datum+Titel statt
Menüpunkte) und ohne den Präsentationsmodus, den ein Blog nicht braucht.
Ein ToDo-Board über der Shell bräuchte nur `todo-lib.mjs` (bereits vorhanden
und getestet) plus `#boardId`-Navigation genau wie das Forum — keine neue
Store-Logik.

## 4. Docs/Beispiele selbst darüber ausliefern — technisch sinnvoll?

**Nein, für die bestehenden Docs nicht.** README/API.md/Whitepaper sind
git-versioniert: Diffs, PR-Review, Lesen ganz ohne Relay-Verbindung oder
Identity-Bootstrap. Als CMS-Inhalt müssten sie durch einen Space-Store, der
zum bloßen LESEN bereits eine Relay-Verbindung braucht — ein echter
Rückschritt gegenüber "Datei laden, fertig". Sinnvoll ist das CMS als
EIGENES Showcase (wie schon in `examples/cms/app.mjs`s `seedDemoSite()`,
das Readme/API-Doku/Beispiele exemplarisch SPIEGELT), nicht als Ersatz der
tatsächlichen Doku-Auslieferung.

## 5. Wichtig beim Selberbauen: der Relay muss es zulassen

"Wenn das Relay es zulässt" trifft es genau — zwei Stellschrauben:

- **Lesen/Schreiben überhaupt möglich:** der Space braucht `readers`/
  `writers`, die zum Anwendungsfall passen (`createSite(qu, { writers: [...],
  readers: ['*'] })`) — kein Relay-Setting, reine Space-ACL (Whitepaper §8.3).
- **Das Relay muss beliebige Space-IDs live weiterleiten dürfen:**
  `createRelay({ allowDynamicSubscribe: true })` (siehe `index.js`) — ohne
  das akzeptiert der Relay nur die statisch vorkonfigurierten `pushTopics`,
  und eine zur Laufzeit neu erzeugte Site (`qu.createSpace()`, zufällige
  UUID) könnte nie live repliziert werden. Dieses Repo hat es in `index.js`
  bereits an, dieselbe Einstellung, die auch `examples/app-space-lib.mjs`s
  mitgliederbeschränkte App-Spaces braucht.
- Und: nach `qu.connect()` einmal `repl.sync({ topic: siteId, since: 0 })`
  aufrufen, wenn man gerade selbst etwas VOR dem `connect()` geschrieben hat
  (z. B. `createSite()`) — sonst bleibt der Relay leer, bis irgendetwas NACH
  `connect()` geschrieben wird (siehe den Kommentar in `examples/cms/app.mjs`
  an genau dieser Stelle, `APP-GUIDE.md` Schritt 5 für die volle Erklärung).

## 6. JavaScript/Reaktivität in Inhalten — via Qu Components

Ein Template- oder Seiten-Block ist ein roher HTML-String, der per
`innerHTML` gerendert wird (`examples/cms/app.mjs`s `renderTemplate()`) —
der Browser initialisiert darin enthaltene Custom Elements automatisch,
ganz ohne `<script>`-Tag (dieselbe Beobachtung aus der ursprünglichen
PDF-Diskussion, hier mit den echten, bereits vorhandenen `src/ui/components.js`-
Elementen statt einer neu erfundenen Komponente). Ein Admin kann also direkt
im Editor lebendigen, reaktiven Inhalt schreiben:

```js
await setPage(qu, siteId, 'todos', {
  title: 'Unsere gemeinsame Liste',
  blocks: { body: `
    <div data-qu-root></div>
    <script type="module">
      import '/src/ui/components.js';
      import { Qu, createSpacesPlugin } from '/src/index.js';
      const qu = (await Qu.create()).use(createSpacesPlugin());
      document.currentScript.previousElementSibling.qu = qu.get('${siteId}');
    </script>
  ` },
});
```

Wichtig: `<script>`-Tags in per `innerHTML` injiziertem HTML werden vom
Browser NICHT ausgeführt (Sicherheitsgrenze, siehe MDN zu `innerHTML`) — nur
Custom-Element-`connectedCallback()`s feuern automatisch. Für eigenes
JavaScript in einem Block bräuchte es entweder serverseitiges/Editor-seitiges
`eval` (bewusst NICHT empfohlen — dieselbe Klasse Sicherheitsproblem wie
`innerHTML` mit ungeprüften Nutzereingaben) oder — der saubere Weg — ein
Template mit vorab im Bundle registrierten Qu Components
(`<qu-list path="…">`, `<qu-view key="…">`, eigene projektspezifische
Elemente), deren Attribute (`path`, `key`) der Admin im Editor frei setzt,
ohne dass dafür neuer Code ausgeliefert werden muss:

```html
<!-- Als Block-HTML einer Seite, komplett ohne <script>: -->
<div data-qu-root>
  <h2>Team-Aufgaben</h2>
  <qu-list path="todos">
    <template>
      <li>
        <qu-view key="text"></qu-view>
        <qu-bind key="done" attr="checked"><input type="checkbox"></qu-bind>
      </li>
    </template>
  </qu-list>
</div>
```

Das setzt voraus, dass die umgebende App (z. B. `examples/cms/app.mjs`)
`import '../../src/ui/components.js'` einmal global lädt und `.qu` auf dem
`[data-qu-root]`-Container jeder frisch gerenderten Seite setzt — ein
kleiner, generischer Erweiterungspunkt, kein Sonderfall pro Block-Typ.
