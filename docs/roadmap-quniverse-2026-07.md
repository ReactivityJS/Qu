# QUniverse Roadmap — Juli 2026: Vier nächste Schritte

Dieses Dokument übersetzt vier grobe Planungsnotizen in konkrete, architektur-verankerte
Entscheidungen, damit eine spätere Session direkt implementieren kann. Es ändert keinen
Code — es ist die Grundlage für vier eigenständige Folge-Sessions.

Für alle vier Punkte gilt: bestehende Bausteine wiederverwenden statt neu bauen. Die
relevanten Module (`src/modules/presence.js`, `src/modules/profiles.js`,
`src/modules/notifications.js`, `examples/forum-lib.mjs`) bieten für jeden Punkt bereits
den Großteil der benötigten Mechanik.

## 1. Forum-Service mit persönlichem Board als Mail-Inbox

**Entscheidung:** Statt einer eigenen Mail-Inbox-Komponente wird der bestehende
Forum-Prototyp zu einem echten Service ausgebaut. Eine "Mail-Inbox" ist dabei einfach ein
Board, das einer einzelnen Identität gehört — dieselbe App bleibt gleichzeitig als
vollwertiges Forum nutzbar und ist eine mögliche spätere Basis für Live-Chat (die
zugrundeliegende Space-/Subscription-Schicht ist bereits reaktiv).

**Umsetzung:**

- Promotion von `examples/forum-lib.mjs` + `examples/forum/app.mjs` nach `services/forum/`
  (`forum-lib.mjs`, `forum-lib.test.mjs`, `app.mjs`, `manifest.mjs`), Registrierung in
  `server/service-registry.mjs` nach dem in `services/README.md` dokumentierten Muster
  (Referenzimplementierung: `services/hello-world/`). `createBoard()`, `createTopic()`,
  `addReply()`, `listPosts()`/`onPosts()`, `listReplies()`/`onReplies()` sowie das
  Monats-Sharding bleiben weitgehend unverändert.
- **Persönliche Inbox = ein Board pro Identität**: `spaceMode: 'perUser'`, deterministische
  Board-Id, lazy erzeugt über `ensureSpace()` (`src/modules/space-membership.js`) beim
  ersten Zugriff. ACL: `writers: [eigene fp, Relay-Admin-fp]` statt der bisherigen
  Demo-Weite `writers: ['*']` — genau "Nutzer oder Relay-Admin dürfen senden".
- **Löschen**: die im Repo bereits etablierte `put(null)`-Tombstone-Konvention für Topics
  und Replies; Leser (`listPosts()`/`listReplies()`) filtern genullte Einträge.
- **Read/Unread**: Wiederverwendung von `src/modules/presence.js`s Read-Receipt-Paar
  (`markRead`/`getReadReceipts`, ein `reads/<fp>`-LWW-Slot = "gelesen bis Zeitstempel X"),
  angewendet auf das Board — funktioniert unverändert, egal ob persönliche Inbox oder
  geteiltes Forum-Board.
- **Push**: neue `createForumPushRule()` in `relay/relay.mjs`, analog zu
  `createChatPushRule()`/`createCalendarPushRule()`, über `spaceWriterRecipients()`
  (`space-membership.js`) für den allgemeinen Forum-Fall. Zusätzlich ruft das Anlegen
  eines Topics in einer fremden persönlichen Inbox explizit `notifyUser()`
  (`src/modules/notifications.js`, `kind: 'mail'`) auf, damit es im
  Welcome-Page-Badge-Feed (`shell/qu-notification-badge.mjs`) sichtbar wird und für Punkt 3
  unten (Notification-Settings) als eigenes `notificationTopics`-Kind adressierbar ist.
- `manifest.mjs`: `notificationTopics: ['mail', 'reply', 'mention']`.

**Offene Frage:** Wer/was ist konkret "Relay Admin" — eine feste Fingerprint-Konstante,
eine Rolle, mehrere Identitäten? Muss vor der Umsetzung der ACL geklärt werden.

## 2. Online-/Offline-Indikator im Profil

**Entscheidung:** `src/modules/presence.js` (`setPresence`, `getPresence`,
`startHeartbeat`) wird unverändert wiederverwendet, aber auf den bereits existierenden
globalen `qu-directory`-Space angewendet (`DIRECTORY_ID`, bereits public exportiert aus
`src/modules/profiles.js`) statt einen neuen Space anzulegen — Präsenz unter
`qu-directory/presence/<fp>`, neben den schon vorhandenen `qu-directory/entries/<fp>`.

**Kopplung an bestehenden Toggle:** der bereits vorhandene `setDirectoryVisible()`-Boolean
steuert, ob der Client `startHeartbeat(qu.get(DIRECTORY_ID), {...})` startet bzw. stoppt.
Da `DIRECTORY_ID` bereits public exportiert ist, reicht `qu.get(DIRECTORY_ID)` direkt —
keine neue Funktion in `profiles.js` nötig.

**Einordnung der Nutzer-Vermutung:** Richtig ist, dass ein einziger Toggle beides steuern
kann. Nicht ganz richtig ist "beides ist im Hintergrund nur ein Custom-Profile-Attribute":
Verzeichnis-Sichtbarkeit UND Online-Status leben im dedizierten `qu-directory`-Space, nicht
unter `~<fp>/attrs/` — weil andere Nutzer sie dort auffinden müssen können, ohne die
Fingerprints vorher zu kennen. Ein reines Identity-Attribut (`~<fp>/attrs/<key>`) bietet
diesen "wer ist gerade sichtbar/online" Einstiegspunkt nicht, ein Space mit `readers: ['*']`
schon.

**UI-Änderung:** `shell/identity-screen.mjs`s `renderVisibilityToggle(qu)` (Zeilen
~281–313) wird um die Presence-Anbindung erweitert, im gleichen Muster
(One-Shot-Read → aktueller Zustand, dann live `.on()`-Subscription, `change`-Listener
schreibt).

**Offene Frage:** Sollen "im Verzeichnis gelistet" und "als online angezeigt" fest
gekoppelt sein, oder zwei unabhängige Toggles werden (z. B. gelistet, aber als offline
erscheinend)?

## 3. Notification-Settings-Page (granulare Steuerung)

**Entscheidung:** Eine neue globale Route (nicht pro Service) unter
`shell/notification-settings.mjs`, gemountet auf `#/settings/notifications`, verlinkt aus
`shell/qu-nav-dropdown.mjs`. Sie listet alle installierten Apps' `notificationTopics`
(bereits dokumentiertes Manifest-Feld, siehe `server/service-registry.mjs`) und rendert je
`(serviceId, topic)`-Paar einen Mute-Toggle nach dem `renderVisibilityToggle`-UI-Muster.

**Persistenz:** pro Mute ein echtes Custom-Profile-Attribut,
`~<fp>/attrs/notify-mute-<serviceId>-<topic>`, über `profiles.js`s
`setProfileAttr`/`getProfileAttr`/`onProfileAttrsChange` — hier trifft "ist einfach ein
Profile-Attribute" tatsächlich zu.

**Durchsetzung:** `notifyUser()` in `src/modules/notifications.js` wird um eine Prüfung des
Mute-Attributs vor dem Schreiben in `inbox-<fp>/notifications/...` erweitert (nur für den
jeweiligen Notification-`kind`).

**Wichtige Einschränkung für v1:** das deckt nur `notifyUser()`-Traffic ab (Mail/Forum-Inbox-
Stil, siehe Punkt 1). Chat, Kalender und "Forum als Forum" laufen über eigene
`pushRules`-Deskriptoren direkt in `relay.mjs` (`createChatPushRule()`,
`createCalendarPushRule()`, `createForumPushRule()`) und würden für ein Muting
Relay-seitiges Lesen von Profil-Daten erfordern — deutlich invasiver. Für v1 wird das
Muting bewusst auf `notifyUser()`-geroutete Topics beschränkt; relay-weites Muting ist eine
offene Frage für eine spätere Iteration.

Der bereits vorhandene All-oder-Nichts-Push-Toggle (`renderPushToggle` in
`identity-screen.mjs`, nutzt `src/ui/push.mjs`) bleibt als übergeordneter
Ein/Aus-Schalter bestehen; die neue Settings-Page verfeinert nur, was INNERHALB einer
aktiven Push-Subscription tatsächlich als Notification ankommt.

**Offene Frage:** Soll das per-Topic-Muting perspektivisch auch relay-seitige Push-Regeln
(Chat/Kalender/Forum) erreichen, oder dauerhaft auf `notifyUser()`-geroutete Topics
beschränkt bleiben?

## 4. Display-Always-On (Wake Lock) für Geo Chase & File-Upload-Sync

**Entscheidung:** Eine neue, gemeinsame Utility unter **`src/ui/wake-lock.mjs`**, parallel
zu `src/ui/push.mjs` platziert — Browser-only (Screen Wake Lock API), daher `src/ui/` statt
`src/core/` (Core muss laut Projektkonvention dependency-/DOM-frei bleiben).

**Form** analog zu `push.mjs`s Stil: `isWakeLockSupported()` (Feature-Detect
`navigator.wakeLock`), `acquireWakeLock()`/`releaseWakeLock()`, sowie automatisches
Re-Acquire bei `visibilitychange` — die Wake Lock API gibt die Sperre beim
Tab-/App-Wechsel automatisch frei; ohne eingebautes Re-Acquire wäre die Funktion in der
Praxis nutzlos für einen Anwendungsfall wie einen mehrstündigen Geo-Chase-Lauf.

Kein Polyfill/Video-Hack-Fallback in v1 (nichts Vergleichbares existiert im Repo bisher) —
bei fehlender Browser-Unterstützung nur Feature-Detect + No-op, analog zur Einfachheit von
`push.mjs`.

**Konsumenten:** `examples/hunt/app.mjs` (Geo Chase) fordert die Sperre während der
aktiven Standort-Ping-Schleife an und gibt sie bei Spielende/Pause frei. Eine
File-Upload-Sync-App existiert im Repo noch nicht (kein Treffer für diesen Namen) — die
Utility wird bewusst so platziert, dass eine künftige File-Upload-Sync-App sie ohne
Duplikation mitverwenden kann, ohne dass diese App hier bereits entworfen wird.

## Offene Fragen (Zusammenfassung)

1. Konkrete Identität/Definition von "Relay Admin" für die Forum-Inbox-ACL (Punkt 1).
2. Feste Kopplung vs. zwei unabhängige Toggles für Verzeichnis-Sichtbarkeit und
   Online-Status (Punkt 2).
3. Umfang des Notification-Mutings — nur `notifyUser()`-Traffic (v1) oder perspektivisch
   auch relay-seitige Push-Regeln (Punkt 3)?
4. Braucht die Forum-Inbox in v1 bereits eine Thread-Ansicht, oder reicht eine flache
   Read/Unread-Liste, um die ursprünglich angefragte Mail-Inbox zu ersetzen (Punkt 1)?

## Referenzierte Dateien

- `src/modules/presence.js` — Presence/Read-Receipts, wiederverwendet in Punkt 1 & 2
- `src/modules/profiles.js` — Custom Attributes + globales Verzeichnis, Punkt 2 & 3
- `src/modules/notifications.js` — generischer Notification-Feed + Push-Rule, Punkt 1 & 3
- `src/modules/space-membership.js` — `ensureSpace()`, `spaceWriterRecipients()`, Punkt 1
- `relay/relay.mjs` — `pushRules`-Extension-Point, Punkt 1 & 3
- `examples/forum-lib.mjs`, `examples/forum/app.mjs` — Ausgangsprototyp für Punkt 1
- `services/README.md`, `services/hello-world/` — Service-/Manifest-Konvention, Punkt 1
- `shell/identity-screen.mjs` — `renderVisibilityToggle()`/`renderPushToggle()`-Muster,
  Punkt 2 & 3
- `src/ui/push.mjs` — Stilreferenz für `src/ui/wake-lock.mjs`, Punkt 4
- `examples/hunt-lib.mjs`, `examples/hunt/app.mjs` — Geo Chase, erster Konsument von Punkt 4
