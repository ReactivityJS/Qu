# src/bundles/

Bundle-Einstiegspunkte für `scripts/build.mjs` — jede Datei hier ist reine
Zusammensetzung (Re-Exports von bereits existierenden `src/**`-Dateien),
niemals eigene Logik. Welches Bundle wofür gedacht ist, steht in der
Tabelle im Haupt-[README](../../README.md#installation); dieselbe
Aufteilung, nur als Code statt Prosa:

- `core.js` — nur `src/core/**` + `MemoryAdapter`/`NullAdapter`.
- `plugins-storage.js` / `plugins-network.js` / `plugins-data.js` — die
  drei optionalen Plugin-Gruppen, unabhängig voneinander importierbar.
- `app-space.js` — der App-Baukasten (Spaces, Mitgliederverwaltung,
  Profile, Chat-Primitive, Presence).
- `ui.js` — reaktive Bindings + Custom Elements. **Browser-only** (siehe
  eigener Datei-Kommentar) — registriert `<qu-view>`/`<qu-bind>`/
  `<qu-list>`/`<qu-profile-card>`/`<qu-people-search>` als Nebeneffekt.
- `core-plugins.js` — `core.js` + alle drei Plugin-Gruppen.
- `all.js` — `core-plugins.js` + `app-space.js` + `ui.js`.

`../index.js` (das Haupt-Barrel) entspricht `core-plugins.js` +
`app-space.js` (plus den Node-sicheren Teilen von `ui.js`, siehe dessen
eigener Kommentar) — bewusst OHNE die Custom Elements, damit dieser
Standard-Import weiterhin problemlos in Node importierbar bleibt.

Ein neuer Export gehört immer zuerst in die passende Datei HIER, nie
direkt (zusätzlich) in `../index.js` — sonst laufen beide auseinander.
