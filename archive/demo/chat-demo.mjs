// CLI presentation of demo/steps.mjs. Contains no QU logic itself — just
// formats each step's title/description/code/result for the terminal.
// Run: npm run demo

import { steps } from './steps.mjs';
import { runSteps } from './run-steps.mjs';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function printResult(entry) {
  console.log(`\n${bold(entry.title)}`);
  console.log(dim(entry.description));
  console.log(cyan(entry.code.split('\n').map((l) => `  ${l}`).join('\n')));

  if (entry.ok) {
    const badge = entry.expectFailure ? green('✓ (erwartete Ablehnung)') : green('✓');
    console.log(badge);
    if (entry.expectFailure && entry.error) {
      console.log(dim(`  → ${entry.error.message}`));
    } else if (entry.result && Object.keys(entry.result).length) {
      for (const [k, v] of Object.entries(entry.result)) console.log(`  ${dim(k + ':')} ${v}`);
    }
  } else {
    console.log(red('✗ unerwarteter Fehler'));
    console.log(red(`  ${entry.error?.stack || entry.error}`));
  }
}

async function main() {
  console.log(bold('\nQU Demo — Alice & Bob, zwei Geräte, ein Framework\n'));
  const results = await runSteps(steps, printResult);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${bold('Fertig.')} ${results.length - failed.length}/${results.length} Schritte wie erwartet.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); if (typeof process !== 'undefined') process.exit(1); });
