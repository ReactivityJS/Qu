# QuCMS als universelle Space-App-Basis

Diese Datei beantwortet die Fragen, die beim Bauen von `examples/cms-lib.mjs`
aufkamen: wie groß eine universelle Inhaltsverwaltung für QU tatsächlich sein
muss, wie man eine Site von komplett leer aus befüllt, ob es sinnvoll ist,
Doku/Beispiele selbst darüber auszuliefern, wie man reaktives JavaScript in
ihre Inhalte bekommt, und ob/wie ein WYSIWYG-Editor dazu passt. Code-
Referenzen sind exakte Pfade in diesem Repo, keine Pseudocode-Skizzen.

## 1. Die Bausteine — und wie groß sie wirklich sind

Drei Schichten, nicht eine — die unterste davon inzwischen Teil des
Frameworks SELBST, nicht mehr nur eines Beispiels:

```
src/modules/spaces.js            ~60 Zeilen  addToRole()/removeFromRole() — EIN generischer Wrapper für
                                              writers/readers/admins, Teil von createSpacesPlugin() (Core!)
examples/space-app-lib.mjs      121 Zeilen  benannte Wrapper darüber (grantWriteAccess, setPublic, …) +
                                              Navigations-Parsing — pure, node-testbar
examples/space-app-browser.js    62 Zeilen  Identity-Bootstrap, Relay-URL, Hash-Watching — browser-only
examples/cms-lib.mjs            173 Zeilen  Config/Templates/Seiten/Menü/Präsentationsmodus — pure, node-testbar
examples/cms-router.js          103 Zeilen  lokal- vs. präsentations-Routing — browser-only
```

Das sind zusammen **~520 Zeilen**, davon ein erheblicher Teil Kommentare
(Repo-Konvention: das WARUM dokumentieren, nicht nur das WAS) — der
tatsächliche Code ist eher die Hälfte. Zum Vergleich: `examples/todo-lib.mjs`
hat 72 Zeilen, `examples/forum-lib.mjs` 62. Ein "CMS-Plugin" für QU ist also
keine neue Kategorie von Komplexität, sondern derselbe Maßstab wie jede
andere Space-App — nur mit fünf statt einer Sorte Inhalt unter einem Space.

**Warum drei Schichten, kein Monolith:**

- `src/modules/spaces.js`s `addToRole()`/`removeFromRole()` sind der Teil,
  der wirklich in JEDER App auf `createSpacesPlugin()` gleich aussieht —
  "füge diesen Fingerprint zu dieser Rolle hinzu/entferne ihn" — deshalb
  jetzt im FRAMEWORK selbst (`qu.addToRole(spaceId, role, fingerprint)`),
  nicht in einem Beispiel: jeder Entwickler, der `createSpacesPlugin()`
  nutzt, bekommt das automatisch, ganz ohne `examples/` zu importieren.
- `space-app-lib.mjs`/`-browser.js` bleiben die BENANNTEN, bequemen Wrapper
  darüber (`grantWriteAccess()` == `addToRole(id, 'writers', fp)`,
  `setPublic(true)` == `addToRole(id, 'readers', '*')`, …) plus das
  einheitliche `#spaceId/pfad`-Adressformat — für ToDo-Liste, Forum-Board
  und CMS-Site identisch, aber (bewusst) noch Beispiel-Code, kein Core.
- `cms-lib.mjs`/`cms-router.js` sind CMS-SPEZIFISCH (Config/Templates/
  Seiten/Präsentationsmodus) — bauen auf der Shell auf, ersetzen aber NICHT
  `todo-lib.mjs`/`forum-lib.mjs`. Ein gemeinsames "Content"-Schema für alle
  drei würde ihre bewusst unterschiedlichen Schreibmuster verwässern (ToDo:
  `set()` + Tombstone-Delete; Forum: `set()` + Zeit-Sharding gegen
  unbegrenztes Wachstum; CMS-Seiten: `put()` pro Slug, ganze Seite auf
  einmal von einer Person editiert) — siehe den Moduldoku-Kommentar in
  `space-app-lib.mjs` für die ausführliche Begründung.

Die Shell ist der Beweis, dass sich der gemeinsame Teil sauber herauslösen
lässt, ohne diesen Unterschied zu verlieren: `examples/forum/app.mjs` und
`examples/cms/app.mjs` nutzen beide dieselbe
`loadOrCreateIdentity()`/`relayUrl()`/`#spaceId/pfad`-Navigation UND
dasselbe `qu.addToRole()`/`qu.removeFromRole()`, aber jede Content-Lib
bleibt ihrem eigenen Schreibmuster treu.

**Nebenbefund beim Bauen von `addToRole()`/`removeFromRole()`:** ein Admin,
der einen generischen Space vollständig privat macht (`readers: []`, kein
`'*'` mehr), konnte sich damit vorher selbst aussperren — nicht nur vom
Schreiben (dokumentiert, akzeptiert), sondern auch vom LESEN des eigenen
Manifests, weil ein generischer Space (anders als ein User-Space) keine
"Admin darf immer lesen"-Garantie hatte. Behoben in
`createSpaceACLResolver()` (`src/modules/spaces.js`): ein Admin darf sein
eigenes Manifest jetzt immer lesen, unabhängig von `readers` — normale
Inhalte unter dem Space bleiben davon unberührt, `readers` gilt dort exakt
wie konfiguriert. Siehe `test/spaces.test.mjs` für die Regressionstests.

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
await setTemplate(qu, siteId, 'default', '<h1>{{title}}</h1><div>{{{body}}}</div>'); // {{{body}}} = roh, siehe Abschnitt 7
await setPage(qu, siteId, 'home', { title: 'Willkommen', blocks: { body: 'Erster Inhalt.' } });
await addNavItem(qu, siteId, { label: 'Start', slug: 'home', order: 1 });

// Nutzerverwaltung — EIN Wrapper für alle drei Rollen (Abschnitt 1):
await qu.addToRole(siteId, 'writers', 'ANDERER-FINGERPRINT');   // Schreibrecht geben
await qu.removeFromRole(siteId, 'writers', 'ANDERER-FINGERPRINT'); // wieder entziehen
await qu.addToRole(siteId, 'readers', '*');    // öffentlich lesbar machen
await qu.removeFromRole(siteId, 'readers', '*'); // wieder privat (dann gezielt einzelne readers hinzufügen)
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
  bereits an, dieselbe Einstellung, die auch `examples/relay-space-demo-lib.mjs`s
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

## 7. Ein schlanker WYSIWYG-Editor — und wie Templates verwaltet werden, wenn nicht als Dateien

**Templates als Dateien auf dem Server gibt es hier bewusst nicht.** Sie
sind QuBits wie alles andere (`cms/templates/<name>`, `setTemplate()`/
`getTemplate()`/`onTemplate()` in `cms-lib.mjs`) — reine HTML-Strings im
selben Space, live editierbar, ohne Deployment/Dateisystem-Zugriff. Das
beantwortet die Frage direkt: "wie verwaltet man HTML, wenn nicht als
statische Datei" ist bereits die Grundarchitektur dieses CMS, kein
Sonderfall, der noch gelöst werden müsste.

**Ja, ein Editor dafür macht Sinn — zwei GETRENNTE, weil zwei GRUNDVERSCHIEDENE
Zielgruppen/Inhalte:**

- **Seiten-Body → WYSIWYG** (`examples/cms/index.html`s `.editor-toolbar` +
  `#edit-body`, ein `contenteditable`-`<div>`). Zielgruppe: Redakteur:innen,
  die Text formatieren, nicht HTML lesen wollen. Umsetzung bewusst
  minimal — `document.execCommand()` für Fett/Kursiv/Überschrift/Liste/Link,
  **keine** neue Abhängigkeit (README/`package.json`: "keine
  Laufzeit-Abhängigkeiten" ist ein Kernprinzip dieses Frameworks, ein
  Rich-Text-Framework wie Quill/TipTap würde dem widersprechen).
  `execCommand()` ist MDN-seitig als veraltet markiert, aber in jedem
  aktuellen Browser weiterhin implementiert; für die Handvoll Grundformate
  hier reicht das. Reicht es NICHT mehr (z. B. Tabellen, eingebettete
  Bilder mit Größenkontrolle), ist der nächste Schritt eine minimale,
  selbst geschriebene Range-basierte Ersetzung statt einer externen
  Bibliothek — passt eher zum Rest dieses Repos als eine neue Dependency.
- **Templates → rohes HTML** (`examples/cms/index.html`s `#template-box`,
  ein normales `<textarea>`). Zielgruppe: technische Admins, die absichtlich
  HTML/Platzhalter (`{{title}}`, `{{{body}}}`) sehen und schreiben wollen —
  ein WYSIWYG-Editor würde hier nur im Weg stehen.

**Zwei Platzhalter-Formen, eine kleine, aber wichtige Unterscheidung**
(`renderTemplate()` in `examples/cms/app.mjs`, Mustache-Konvention):
`{{title}}` (zwei Klammern) wird ESCAPED eingesetzt — für einfache
Textfelder. `{{{body}}}` (drei Klammern) wird ROH eingesetzt — nötig, weil
der WYSIWYG-Editor bereits HTML liefert (`<b>…</b>` etc.), das escaped
sichtbar als Text `&lt;b&gt;` erscheinen würde statt fett dargestellt zu
werden.

**Sicherheitsmodell, explizit durchdacht statt stillschweigend
vorausgesetzt:** rohes Einsetzen von `{{{body}}}` eröffnet KEINE neue
Fähigkeit gegenüber dem, was ein Site-Writer schon hat — wer Schreibrecht
auf der Site besitzt, kann über `setTemplate()` (Konsole oder
Template-Box) ohnehin schon beliebiges HTML in die Site schreiben, keine
Prüfung dagegen, absichtlich (dieselbe "Writer = Content-Autor" Vertrauensstufe
wie jedes CMS/Wiki mit internem Redaktionsteam). Der WYSIWYG-Editor macht
diese bereits vorhandene Fähigkeit nur bequemer zugänglich, nicht
mächtiger. Wichtig bleibt die Grenze NACH AUSSEN: `<script>`-Tags in per
`innerHTML` injiziertem HTML werden vom Browser nicht ausgeführt (siehe
Abschnitt 6) — aber Event-Attribute wie `onerror="…"` in eingefügtem HTML
FEUERN. Das ist kein Bug hier, sondern der bewusste Rahmen: Autoren-Content
von VERTRAUTEN Writern (ACL-geprüft), nicht ungeprüfte Eingabe von
Fremden — dieselbe Grenze, die auch ein normales CMS mit Redakteursrollen
zieht, nicht strenger und nicht loser. Für einen echt offenen Space
(`writers: ['*']`, wie `examples/forum/app.mjs`s Demo-Board) NIEMALS
`{{{body}}}`/rohes HTML aus Nutzereingaben verwenden — dort bleibt reiner
Text (`{{body}}`, escaped) die richtige Wahl, weil dort JEDE:R schreiben darf.
