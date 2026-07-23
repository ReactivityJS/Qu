// Bündelt das Framework (src/index.js und alles, was es transitiv
// importiert) zu EINER Datei, die sich per <script type="module"> laden
// lässt, ohne dass ein Konsument (z. B. ein separates Messenger-Repo)
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
// Läuft lokal (`npm run build`) genauso wie in CI
// (.github/workflows/build-cdn.yml, nach jedem Merge nach main).

import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const ENTRY = 'src/index.js';
const OUT_DIR = 'dist';
const BANNER = `/*! QU (qu-core) — Zero-Trust framework, gebündelt aus ${ENTRY}. https://github.com/reactivityjs/qu */\n`;

await mkdir(OUT_DIR, { recursive: true });

/** Unminifiziert — lesbar für's Debuggen eines Konsumenten, der die CDN-Datei direkt einbindet (Kommentare/Namen bleiben erhalten). */
const readable = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  banner: { js: BANNER },
  outfile: `${OUT_DIR}/qu.js`,
  write: true,
  metafile: true,
});

/** Minifiziert + Sourcemap — für den tatsächlichen CDN-Einsatz (kleinste Downloadgröße), Sourcemap hält Debugging trotzdem möglich. */
await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  banner: { js: BANNER },
  outfile: `${OUT_DIR}/qu.min.js`,
  write: true,
});

// Kleine Metadaten-Datei daneben — welcher Commit/welche package.json-
// Version wurde gebaut, damit ein per @main gezogenes dist/qu.min.js
// (das jsDelivr NICHT versioniert cached) sich trotzdem zurückverfolgen
// lässt, ohne extra ins Git-Log schauen zu müssen.
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  `${OUT_DIR}/build-info.json`,
  JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null }, null, 2) + '\n',
);

const inputCount = Object.keys(readable.metafile.inputs).length;
console.log(`[build] dist/qu.js + dist/qu.min.js geschrieben (${inputCount} Quelldateien gebündelt).`);
