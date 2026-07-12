// Runs the given test files with node:test's own programmatic run() API
// (not the CLI's --test-reporter flag — its built-in reporter names have
// resolution quirks that vary across Node versions) and prints a plain
// JSON array of results to stdout. Used two ways:
//   - standalone: `node scripts/run-node-only.mjs test/relay.test.mjs ...`
//   - as an isolated child process spawned by server/test-runner.mjs, so a
//     hang or crash in a test can never take the actual relay/static
//     server down with it — this script's own exit is the failure boundary.
// Deliberately lives outside test/: Node's default `--test` file discovery
// treats every .?(c|m)js file inside a directory named "test" as a test
// file in its own right, which made `npm test` fail on this file's own
// "no args" usage check when it sat next to the real *.test.mjs files.
import { run } from 'node:test';
import path from 'node:path';

const files = process.argv.slice(2).map((f) => path.resolve(f));
if (!files.length) {
  console.error('Usage: node scripts/run-node-only.mjs <file.test.mjs> ...');
  process.exit(1);
}

const results = [];
const stream = run({ files });
for await (const event of stream) {
  if (event.type === 'test:pass' || event.type === 'test:fail') {
    // event.data.file is the absolute path node:test resolved the test to —
    // present on both pass/fail events, used to group results by source
    // file the same way the browser dashboard groups its own.
    results.push({
      file: event.data.file ? path.relative(process.cwd(), event.data.file) : null,
      name: event.data.name,
      pass: event.type === 'test:pass',
      duration: event.data.details?.duration_ms ?? null,
      error: event.type === 'test:fail' ? (event.data.details?.error?.message ?? String(event.data.details?.error)) : null,
    });
  }
}

process.stdout.write(JSON.stringify(results));
