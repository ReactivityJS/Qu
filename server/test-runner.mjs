// Wires two endpoints into the dev server for test/index.html's unified
// dashboard — QU-specific knowledge that deliberately does NOT live in
// static-server.mjs (see its own doc comment):
//
//   GET /test/manifest.json     — which test/*.test.mjs files can run in a
//                                 browser vs. which need real Node built-ins.
//   GET /test/run-node-tests    — actually runs the Node-only ones and
//                                 returns their results as JSON.
//
// Classification is by SCANNING each file's imports at request time, not a
// hand-maintained list — a file is browser-safe iff its only `node:*`
// imports are `node:test`/`node:assert` (both browser-shimmed via
// test/index.html's import map). This is the same "self-maintaining beats
// hand-maintained" fix as core/pattern.js earlier: test/index.html used to
// hard-code which files to import and silently fell behind as new test
// files were added — this can't go stale the same way, because there's no
// list to forget to update.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const NODE_IMPORT_RE = /from\s+['"]node:([a-zA-Z_/-]+)['"]/g;
const BROWSER_SAFE_BUILTINS = new Set(['test', 'assert', 'assert/strict']);

async function classifyTestFiles(testDir) {
  const entries = await fs.readdir(testDir);
  const testFiles = entries.filter((f) => f.endsWith('.test.mjs')).sort();
  const browserSafe = [];
  const nodeOnly = [];
  for (const file of testFiles) {
    const content = await fs.readFile(path.join(testDir, file), 'utf8');
    const imports = [...content.matchAll(NODE_IMPORT_RE)].map((m) => m[1]);
    const isBrowserSafe = imports.every((mod) => BROWSER_SAFE_BUILTINS.has(mod));
    (isBrowserSafe ? browserSafe : nodeOnly).push(file);
  }
  return { browserSafe, nodeOnly };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * `enabled` gates the actual test-EXECUTION endpoint (manifest listing is
 * always on — it only reads file contents, no code runs). Off by default:
 * spawning `node --test`-equivalent work on every request is fine for local
 * dev, but an unauthenticated "run code on my server" trigger is a real
 * concern the moment this dev server is reachable beyond localhost — same
 * opt-in-env-var pattern as QU_DEBUG elsewhere in this repo. Results are
 * cached for `cacheMs` (default 30s) so a burst of page loads/reloads
 * triggers at most one actual run, not one per request.
 */
export function createTestRoutes({ root, testDir = path.join(root, 'test'), enabled = process.env.QU_ENABLE_TEST_ENDPOINT === '1', cacheMs = 30_000 } = {}) {
  let cache = null; // { at, result }

  return [
    {
      match: (p) => p === '/test/manifest.json',
      handle: async (_req, res) => {
        try {
          const manifest = await classifyTestFiles(testDir);
          json(res, 200, manifest);
        } catch (e) {
          json(res, 500, { error: 'manifest-failed', message: e.message });
        }
      },
    },
    {
      match: (p) => p === '/test/run-node-tests',
      handle: async (_req, res) => {
        if (!enabled) {
          json(res, 403, {
            error: 'disabled',
            message: 'Server-seitige Testausführung ist deaktiviert. Mit QU_ENABLE_TEST_ENDPOINT=1 beim Serverstart aktivieren (siehe README).',
          });
          return;
        }
        if (cache && Date.now() - cache.at < cacheMs) {
          json(res, 200, cache.result);
          return;
        }
        try {
          const { nodeOnly } = await classifyTestFiles(testDir);
          const files = nodeOnly.map((f) => path.join(testDir, f));
          const stdout = await new Promise((resolve, reject) => {
            execFile('node', [path.join(root, 'scripts', 'run-node-only.mjs'), ...files], { cwd: root, timeout: 60_000 }, (err, out, stderr) => {
              // execFile's own `err` covers both a non-zero exit AND a timeout kill —
              // run-node-only.mjs always prints its JSON result even when individual
              // tests fail (only a crash/timeout of the runner itself has no stdout).
              if (out) resolve(out);
              else reject(err ?? new Error(stderr || 'no output'));
            });
          });
          const result = { files: nodeOnly, results: JSON.parse(stdout) };
          cache = { at: Date.now(), result };
          json(res, 200, result);
        } catch (e) {
          json(res, 500, { error: 'run-failed', message: e.message });
        }
      },
    },
  ];
}
