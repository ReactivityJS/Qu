import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrGenerateRelayIdentity } from '../relay/relay-identity.mjs';

test('loadOrGenerateRelayIdentity(): generates once, then reloads the SAME identity (same fingerprint) on every subsequent call', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qu-relay-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'relay-identity.json');

  assert.equal(fs.existsSync(filePath), false);
  const first = await loadOrGenerateRelayIdentity(filePath);
  assert.ok(fs.existsSync(filePath), 'first call must persist the generated identity to disk');

  const second = await loadOrGenerateRelayIdentity(filePath);
  assert.equal(second.fingerprint, first.fingerprint, 'a reload must reconstruct the same identity, not generate a fresh one');

  const third = await loadOrGenerateRelayIdentity(filePath);
  assert.equal(third.fingerprint, first.fingerprint);
});
