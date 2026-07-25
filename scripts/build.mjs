// Bündelt das Framework zu mehreren <script type="module">-fähigen
// Dateien, ohne dass ein Konsument (z. B. ein separates Messenger-Repo)
// selbst einen Bundler braucht oder relative Importpfade über mehrere
// Dateien hinweg auflösen muss. Bewusst der denkbar einfachste Builder:
// esbuild macht die eigentliche Arbeit (Bundling + Minifying), dieses
// Skript ist nur die dünne Konfiguration darüber — kein eigenes
// Build-System, keine Plugins, kein Wasm/Loader-Gedöns. src/ selbst
// bleibt unverändert reines, direkt im Browser lauffähiges ESM (die
// Demos in examples/ importieren weiterhin `../../src/index.js` ohne
// Bundling) — dist/ ist ein zusätzliches, rein für externe Konsumenten
// gedachtes Artefakt, kein Ersatz dafür.
//
// Mehrere Bundles statt eines einzigen: ein Konsument, der nur Core (oder
// nur Core + eine bestimmte Plugin-Gruppe) braucht, soll nicht das ganze
// Framework laden müssen. Jeder Eintrag unten ist eine reine
// Zusammensetzung existierender src/bundles/*.js-Dateien (selbst wieder
// nur Re-Exports, keine eigene Logik) — welche Module tatsächlich zu
// welchem Bundle gehören, steht dort, nicht hier.
//
// Läuft lokal (`npm run build`) genauso wie in CI
// (.github/workflows/build-cdn.yml, nach jedem Merge nach main).

import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const OUT_DIR = 'dist';

/**
 * name: Dateiname-Präfix in dist/ (`<name>.js` + `<name>.min.js`).
 * entry: der Bundle-Einstiegspunkt (src/bundles/*.js, oder src/index.js
 *   selbst für `qu` — die etablierte, bereits als CDN-URL dokumentierte
 *   "Standard"-Datei, unverändert am selben Pfad, damit ein bestehender
 *   `@dist/qu.min.js`-Verweis nicht bricht).
 * label: Kurzbeschreibung für die Build-Log-Ausgabe.
 */
const BUNDLES = [
  { name: 'qu', entry: 'src/index.js', label: 'Alles außer UI (bisheriger Standard-Export, Node-sicher)' },
  { name: 'qu-core', entry: 'src/bundles/core.js', label: '1) Core' },
  { name: 'qu-plugins-storage', entry: 'src/bundles/plugins-storage.js', label: '2) Plugins — Storage' },
  { name: 'qu-plugins-network', entry: 'src/bundles/plugins-network.js', label: '2) Plugins — Network' },
  { name: 'qu-plugins-data', entry: 'src/bundles/plugins-data.js', label: '2) Plugins — Data/Files' },
  { name: 'qu-app-space', entry: 'src/bundles/app-space.js', label: '3) App-Space-Module' },
  { name: 'qu-ui', entry: 'src/bundles/ui.js', label: '4) UI-Komponenten + Plugin' },
  { name: 'qu-core-plugins', entry: 'src/bundles/core-plugins.js', label: '5) Core + optionale Plugins' },
  { name: 'qu-all', entry: 'src/bundles/all.js', label: '6) Alles (Core + Plugins + App-Space + UI)' },
];

await mkdir(OUT_DIR, { recursive: true });

let totalInputs = 0;
for (const { name, entry, label } of BUNDLES) {
  const banner = `/*! QU (${name}) — Zero-Trust framework. ${label}. Gebündelt aus ${entry}. https://github.com/reactivityjs/qu */\n`;

  // Unminifiziert — lesbar für's Debuggen eines Konsumenten, der die
  // CDN-Datei direkt einbindet (Kommentare/Namen bleiben erhalten).
  const readable = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    banner: { js: banner },
    outfile: `${OUT_DIR}/${name}.js`,
    write: true,
    metafile: true,
  });

  // Minifiziert + Sourcemap — für den tatsächlichen CDN-Einsatz (kleinste
  // Downloadgröße), Sourcemap hält Debugging trotzdem möglich.
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: true,
    banner: { js: banner },
    outfile: `${OUT_DIR}/${name}.min.js`,
    write: true,
  });

  const inputCount = Object.keys(readable.metafile.inputs).length;
  totalInputs += inputCount;
  console.log(`[build] dist/${name}.js + dist/${name}.min.js (${label}, ${inputCount} Quelldateien)`);
}

// Kleine Metadaten-Datei daneben — welcher Commit/welche package.json-
// Version wurde gebaut, damit ein per @main gezogenes dist/*.min.js (das
// jsDelivr NICHT versioniert cached) sich trotzdem zurückverfolgen lässt,
// ohne extra ins Git-Log schauen zu müssen.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  `${OUT_DIR}/build-info.json`,
  JSON.stringify({
    version: pkg.version,
    builtAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    bundles: BUNDLES.map(({ name, label }) => ({ name, label })),
  }, null, 2) + '\n',
);

console.log(`[build] ${BUNDLES.length} Bundles geschrieben (${totalInputs} Quelldatei-Einbindungen insgesamt).`);
