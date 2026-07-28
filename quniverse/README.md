# QUniverse

Ein Qu-basiertes Ökosystem: ein zentraler Relay/Domain-Einstiegspunkt,
ein gemeinsames Nutzerverzeichnis (opt-in), Cross-App-Benachrichtigungen und
mehrere unabhängig entwickelte, aber zusammen funktionierende Apps (Forum,
Chat, Messenger, ToDo, Kalender, Kontakte, CMS, Geo-Chase, …) — alle auf
Basis des [Qu-Frameworks](../README.md).

**Qu ist der Core** (Identität, Spaces, ACL/Verschlüsselung, Netzwerk/Relay,
wiederverwendbare App-Bausteine wie Spaces/Membership/Profiles/Chat/
Notifications, reaktive `<qu-*>`-Components, `../src/`, `../relay/`,
`../server/` relativ zu diesem Ordner) — dieser Ordner ist das darauf
aufbauende **Produkt**: eine konkrete Relay-Deployment-Konfiguration, die
Ökosystem-Shell (Willkommensseite, Navigation, Identity-Viewer), ein
erweitertes Relay-Admin-Dashboard, und die konkreten Apps selbst.

## Warum ein Unterordner in diesem Repo, kein eigenes Repo mehr

QUniverse lag ursprünglich in einem eigenen Repo (`ReactivityJS/QUniverse`),
das Qu per `github:`-npm-Abhängigkeit referenzierte. Das scheiterte in der
Praxis: `npm install` ruft dafür intern den `git`-Befehl auf
(`child_process.spawn('git', …)`) — fehlt `git` auf dem `PATH` oder ist es
nicht erreichbar, bricht die Installation mit `ENOENT: spawn git` ab, noch
bevor überhaupt Code geladen wird. Da Qu (noch) keine Release-Tags/kein
veröffentlichtes npm-Paket hat und sich mit jedem Commit ändert, gab es
keinen stabilen, git-freien Bezugspunkt für ein separates Repo.

Die Lösung: QUniverse lebt jetzt als Unterordner **in diesem Repo**, mit
reinen relativen ES-Module-Imports (`../src/index.js` usw.) statt eines
Paket-Managers — genau demselben Muster, das jedes Beispiel unter
`../examples/` bereits nutzt. Kein `package.json`, kein `npm install`, kein
`node_modules/`, keine `git`-Abhängigkeit mehr — dieser Ordner ist einfach
ein weiterer Teil des Qu-Repos, direkt lauffähig mit reinem Node.

Das vollständige Architektur-/Phasenkonzept entstand phasenweise in der
Commit-Historie dieses Branches (`claude/quniverse-ecosystem-architecture-cd289p`)
— dieselbe Quelle wie zuvor, jetzt nur ohne Repo-übergreifenden Verweis.

## Status

**Fundament + Shell** — abgeschlossen: geteilte Identity-Bootstrap-
Konvention, generisches Notifications-Modul, Relay-Rate-Limit/
Connection-Limit/Plattform-Modul-Toggles als laufzeit-konfigurierbare
Admin-Features, erweitertes App-/Service-Manifest-Format
(`../server/service-registry.mjs`), echter Router-Dispatch
(`../src/ui/router.js`, space-first, Node-testbar), `<qu-app-shell>`
(bootstrapt Identity + Relay-Verbindung, setzt `.qu` für den gesamten
Baum), `<qu-nav-dropdown>`, `~<fp>`/`u/<fp>`-Identity-Viewer
(Profilkarte, Verzeichnis-Sichtbarkeits-Toggle, Teilen-Button,
Push-Toggle, App-Teilnahme).

**Ein-Fenster-Ökosystem** — abgeschlossen: ein Service-Manifest mit
`mount` (statt/zusätzlich zu `entry`) wird von `<qu-app-shell>` per
dynamischem `import()` DIREKT in die Shell gemountet, ohne Seitenwechsel —
dieselbe Identität/Verbindung/Runtime bleibt für die ganze Sitzung
bestehen. `entry`-only-Services bleiben als eigenständige Seiten möglich
(Fallback, nicht der Regelfall).

**Zentrale Benachrichtigungen, Teilen, Push** — abgeschlossen:
`<qu-notification-badge>` fasst Qu-Cores generische
`onNotification()`/`onSpaceInvite()`-Feeds in einem Header-Badge/Dropdown
zusammen; `shareContent()` (Qu-Core) für ausgehendes Teilen (Web Share API
+ Zwischenablage-Fallback); Web Push Ende-zu-Ende verdrahtet
(`createNotificationPushRule()` in Qu-Core — JEDER Aufruf von
`qu.notifyUser()` löst automatisch einen Push aus, kein App-spezifisches
Push-Rule nötig), Service Worker mit Scope `/quniverse/` (`sw.js`,
registriert unter `/quniverse/sw.js`) + `manifest.webmanifest` für
Installierbarkeit.

Noch offen: CMS-Startseite pro Nutzer, die ersten echten Apps unter
`services/` (Profil-Bearbeitung + Kontakte sind der nächste Schritt). Details
zur QUniverse-eigenen App-/Service-Registrierung mit `mount` folgen dort,
sobald der erste echte Service hinzukommt.

## Kein `package.json`, keine Abhängigkeit — reine relative Imports

Dieser Ordner hat **kein eigenes `package.json`** und **kein
`node_modules/`**. Jede Datei importiert Qu direkt über einen relativen Pfad
in dieses Repo hinein (`server.mjs` → `../src/index.js`,
`../relay/relay.mjs`, `../server/static-server.mjs`; `shell/*.mjs` →
`../../src/...`) — exakt dasselbe Muster, das jedes Beispiel unter
`../examples/` bereits verwendet. Kein Build-Schritt, kein `npm install`,
keine Versions-/Tag-Frage: dieser Ordner läuft immer gegen genau den
`src/`/`relay/`/`server/`-Stand, der im selben Commit dieses Repos liegt.

## Struktur

```
quniverse/
  server.mjs      Relay-Deployment-Einstiegspunkt — importiert createRelay()
                  aus ../relay/relay.mjs, konfiguriert relayAdmins/Rate-Limit/
                  Connection-Limit/Plattform-Module/Web-Push über
                  Umgebungsvariablen (dieselben Namen wie in Qu's eigenem
                  index.js), registriert die konkrete Service-Liste dieses
                  Ökosystems. Der statische Datei-Server serviert dabei den
                  GESAMTEN Qu-Repo-Root (nicht nur diesen Ordner) — nötig,
                  damit `../src/...`-Importe auch im Browser auflösen —
                  darum ist die Shell unter `/quniverse/`, nicht `/`,
                  erreichbar (siehe "Lokal starten" unten).
  sw.js           Service Worker, registriert unter `/quniverse/sw.js` mit
                  Scope `/quniverse/` — Push-Empfang + Installierbarkeit für
                  diese Shell, ohne unrelated `/examples/`-/`/docs/`-/
                  `/test/`-Inhalte desselben Origins zu berühren.
  manifest.webmanifest  PWA-Manifest (Name, Icons, Start-URL) für "Zum
                  Startbildschirm hinzufügen"/Installations-Prompt.
  services/       Ein Verzeichnis pro App, nach dem App-/Service-Template
                  (siehe services/README.md) — noch leer, erste Apps folgen
                  in einer späteren Phase.
```

**Umgebungsvariablen** (alle optional, mit sinnvollen Defaults):

| Variable | Zweck | Default |
|---|---|---|
| `PORT` | HTTP/WebSocket-Port | `8788` |
| `QU_RELAY_ADMINS` | Kommagetrennte Fingerprint-Liste mit Admin-Rechten | leer (kein Admin) |
| `QU_RATE_LIMIT_MAX` / `QU_RATE_LIMIT_WINDOW_MS` | Rate-Limit pro Fingerprint | `200` / `1000` |
| `QU_RATE_LIMIT=0` | Rate-Limit deaktivieren | aktiv |
| `QU_MAX_CONNECTIONS` / `QU_ALLOWED_FINGERPRINTS` | Verbindungslimit | unbegrenzt |
| `QU_PLATFORM_MODULES_DISABLED` | Kommagetrennte Plattform-Modul-Ids abschalten (`contacts`, `cms-homepage`, `notifications`, `directory`, `incognito`) | alle aktiv |
| `QU_PUSH=0` | Web Push deaktivieren | aktiv |
| `QU_VAPID_PUBLIC_KEY` / `QU_VAPID_PRIVATE_KEY` | Festes VAPID-Schlüsselpaar statt Auto-Generierung | auto-generiert, **flüchtig** (siehe Deploy-Hinweise unten) |
| `QU_VAPID_SUBJECT` | Kontakt-URI im VAPID-JWT (`mailto:...`) | `mailto:admin@example.com` |
| `QU_DEBUG=1` | Ausführliches Relay-Logging | aus |

`QU_STORE` (aus Qu's eigenem `index.js` bekannt) wird von DIESEM
`server.mjs` bisher **nicht** ausgewertet — der Store ist heute
strukturell immer `MemoryAdapter`-basiert (siehe Deploy-Hinweise unten),
unabhängig von dieser Variable.

## Lokal starten

Aus dem **Qu-Repo-Root** (kein separates `npm install` in diesem Ordner —
es gibt hier kein `package.json`, Qu selbst hat keine Laufzeit-Abhängigkeiten):

```
npm run quniverse
```

(äquivalent: `node quniverse/server.mjs` direkt aus dem Repo-Root aufrufen —
kein `npm install` nötig, weder hier noch in Qu selbst, außer man will auch
den optionalen CDN-Bundle-Build von Qu nutzen, siehe Qu's eigenes README.)

Startet einen Relay auf `ws://localhost:8788/relay` (Port über `PORT`
konfigurierbar) UND liefert die Shell selbst über denselben Prozess aus —
erreichbar unter **`http://localhost:8788/quniverse/`** (nicht `/`: der
statische Server serviert den gesamten Repo-Root, siehe "Struktur" oben,
damit `../src/...`-Importe auch im Browser auflösen). Ohne `QU_RELAY_ADMINS`
gesetzt hat niemand Admin-Rechte (Services togglen, Rate-Limit/
Connection-Limit ändern) — siehe Qu's `../examples/relay-admin` für ein
Referenz-Dashboard, das gegen diesen Relay läuft.

## Deploy-/Update-Hinweise

Kein `docker-compose.yml`/`Dockerfile` existiert in diesem Repo — falls
extern eines betrieben wird (eigenes Hosting-Setup), betreffen die neuen
Features aus dieser Version NUR die folgenden Punkte, keine
Image-/Build-Änderung:

- **Keine neue Laufzeit-Abhängigkeit.** Web Push (`../relay/webpush.mjs`)
  nutzt ausschließlich `node:crypto` + globales `fetch` — beides bereits
  in Node ≥ 20 vorhanden (Qu-Repo-Roots `package.json`s `engines`-Feld).
  Kein `npm install` in diesem Ordner nötig, es zieht keine neuen Pakete.
- **Kein neuer Port, kein neues Volume nötig.** `sw.js`/`manifest.webmanifest`/
  `icons/` werden vom bestehenden statischen Datei-Server automatisch
  mit ausgeliefert (derselbe Mechanismus wie `index.html`/`app.mjs`) —
  keine neue Route, kein neuer Prozess.
- **HTTPS ist Pflicht für Push/Installierbarkeit — außer auf `localhost`.**
  Service Worker UND die Push API verweigern sich in jedem Browser
  außerhalb eines "sicheren Kontexts" (HTTPS oder `localhost`). Läuft
  dieser Relay hinter einem Reverse Proxy (nginx/Caddy/Traefik o. Ä.),
  muss DER die TLS-Terminierung übernehmen — ohne das schlägt
  `navigator.serviceWorker.register('/quniverse/sw.js')` in der Shell einfach
  fehl (kein Crash, aber leise: kein Installations-Prompt, kein Push
  möglich, die übrige App funktioniert unverändert weiter).
- **VAPID-Schlüssel jetzt explizit pinnen, wenn Push über einen Neustart
  hinweg stabil bleiben soll.** Ohne `QU_VAPID_PUBLIC_KEY`/
  `QU_VAPID_PRIVATE_KEY` generiert `server.mjs` bei JEDEM Prozessstart ein
  neues Schlüsselpaar (derselbe Ephemeral-Charakter, den die
  Relay-Identität selbst heute schon hat — beides ist bisher NICHT
  dateibasiert persistiert, anders als Qu's eigenes `index.js`). Ein
  Container-Neustart (Deploy, Crash-Recovery, Autoscaling) macht damit
  JEDE bestehende Push-Subscription eines Browsers ungültig — Nutzer
  müssten Push erneut aktivieren. Empfehlung für einen produktiven
  Rollout: einmalig ein Schlüsselpaar erzeugen (z. B. lokal, aus dem
  Qu-Repo-Root, via
  `node -e "import('./relay/webpush.mjs').then(m => console.log(m.generateVapidKeys()))"`)
  und als `QU_VAPID_PUBLIC_KEY`/`QU_VAPID_PRIVATE_KEY` in der
  Docker-Compose-`environment:`-Sektion bzw. den Secrets des jeweiligen
  Node-Hostings hinterlegen — genau wie `QU_RELAY_ADMINS` bereits heute
  empfohlen als Deployment-Konfiguration behandelt wird, nicht im Repo.
- **Push testet man nicht ohne HTTPS.** Ein lokaler `npm run quniverse` auf
  `http://localhost` reicht für die Server-seitige Verdrahtung
  (`/push/vapid-public-key`, `admin/config/*`), aber `PushManager.subscribe()`
  selbst braucht einen echten sicheren Kontext UND Netzwerkzugriff auf den
  jeweiligen Push-Dienst des Browsers (z. B. Googles FCM-Endpunkte) — in
  einer Sandbox/CI ohne Internetzugriff schlägt das erwartungsgemäß fehl
  (siehe `../src/ui/push.mjs`s eigene Tests für die davon unabhängig
  testbare Logik).
