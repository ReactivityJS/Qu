import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, QuIdentity, QuSession, QuStore, MemoryAdapter, NullAdapter, createSpacesPlugin } from '../src/index.js';
import { createRelay } from '../relay/relay.mjs';
import { getTheme, setTheme, onThemeChange } from '../src/ui/theme.js';
import { withSilencedConsoleError } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// createSpacesPlugin() is needed here for the same reason
// examples/relay-admin/app.mjs's own doc comment explains for
// admin/service/<id>: `relay-config/theme` is a plain generic Space this
// caller never creates a manifest for, so it's only writable LOCALLY at
// all once the Spaces bootstrap rule ("no manifest yet = anyone may
// write") is installed — the Core default (`~<fingerprint>/**`-only)
// would otherwise reject the write before it ever reaches a relay's own,
// separate ACL check (see the relay-level test below for that one).

test('getTheme()/setTheme(): a full round trip on a Qu instance', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  assert.equal(await getTheme(qu), null, 'nothing set yet');

  await setTheme(qu, { accent: '#ff6600', bg: '#101014' });
  assert.deepEqual(await getTheme(qu), { accent: '#ff6600', bg: '#101014' });
});

test('setTheme(): a full replace, not a per-key patch', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  await setTheme(qu, { accent: '#ff6600', bg: '#101014' });
  await setTheme(qu, { accent: '#00ff00' });
  assert.deepEqual(await getTheme(qu), { accent: '#00ff00' }, '"bg" from the first write must not survive — setTheme() replaces the whole object');
});

test('onThemeChange(): a not-yet-set theme delivers nothing initially (no QuBit to catch up on yet), then every future change fires live', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  const seen = [];
  onThemeChange(qu, (q) => seen.push(q?.value ?? null));
  await wait(10);
  assert.deepEqual(seen, [], 'nothing to catch up on for a path that was never written');

  await setTheme(qu, { accent: 'red' });
  await setTheme(qu, { accent: 'blue' });
  await wait(10);
  assert.deepEqual(seen, [{ accent: 'red' }, { accent: 'blue' }]);
});

test('onThemeChange(): once a theme exists, a NEW subscriber gets it immediately (initial catch-up)', async () => {
  const qu = (await Qu.create()).use(createSpacesPlugin());
  await setTheme(qu, { accent: 'green' });

  const seen = [];
  onThemeChange(qu, (q) => seen.push(q?.value ?? null));
  await wait(10);
  assert.deepEqual(seen, [{ accent: 'green' }], 'initial catch-up delivers the already-existing value');
});

function makeStoreWithConfigPrefix() {
  return new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'admin/', adapter: new NullAdapter(), replicate: false },
  ]);
}

test('relay ACL: relay-config/theme is writable only by a relayAdmins fingerprint, publicly readable', async () => {
  const admin = await QuIdentity.generate();
  const outsider = await QuIdentity.generate();
  const relayApi = await createRelay({ store: makeStoreWithConfigPrefix(), relayAdmins: [admin.fingerprint] });

  const adminSession = new QuSession(relayApi.relay.runtime, { identity: admin });
  const outsiderSession = new QuSession(relayApi.relay.runtime, { identity: outsider });

  await withSilencedConsoleError(async () => {
    await assert.rejects(
      outsiderSession.publish('relay-config/theme', { accent: 'hacked' }),
      /ACL/,
      'a non-admin fingerprint must never be able to set the deployment-wide theme',
    );
  });

  await adminSession.publish('relay-config/theme', { accent: '#ff6600' });
  await wait(10);

  const readByOutsider = await outsiderSession.get('relay-config/theme');
  assert.deepEqual(readByOutsider.value, { accent: '#ff6600' }, 'anyone may read the theme, same as relay-services/<id>');
});
