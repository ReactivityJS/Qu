import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debug, onDebug } from '../src/index.js';

test('debug() is a no-op with zero listeners (no error, nothing to observe)', () => {
  assert.doesNotThrow(() => debug('test', 'event', { a: 1 }));
});

test('onDebug() receives emitted entries with scope/event/data/ts', () => {
  const seen = [];
  const off = onDebug((entry) => seen.push(entry));
  debug('core', 'ingest-accepted', { id: 'x' });
  off();
  debug('core', 'ingest-accepted', { id: 'y' }); // must not be seen after unsubscribe

  assert.equal(seen.length, 1);
  assert.equal(seen[0].scope, 'core');
  assert.equal(seen[0].event, 'ingest-accepted');
  assert.deepEqual(seen[0].data, { id: 'x' });
  assert.ok(typeof seen[0].ts === 'number');
});

test('a throwing listener does not break debug() for other listeners or the caller', () => {
  const seen = [];
  const offBad = onDebug(() => { throw new Error('bad listener'); });
  const offGood = onDebug((entry) => seen.push(entry));
  assert.doesNotThrow(() => debug('x', 'y', {}));
  assert.equal(seen.length, 1);
  offBad();
  offGood();
});

test('runtime.ingest() emits accepted/rejected/noop debug events', async () => {
  const { QuRuntime, QuStore, MemoryAdapter, createVerifyPlugin } = await import('../src/index.js');
  const runtime = new QuRuntime({ store: new QuStore([{ prefix: '', adapter: new MemoryAdapter() }]) });
  runtime.use(createVerifyPlugin());

  const seen = [];
  const off = onDebug((entry) => { if (entry.scope === 'runtime') seen.push(entry); });

  await runtime.publish('x/1', 'a', { ts: 100 });
  await runtime.publish('x/1', 'a', { ts: 100 }); // same ts -> noop
  await runtime.ingest({ id: 'x/1', value: 'stale', ts: 50 }); // older -> superseded

  off();
  const events = seen.map((e) => e.event);
  assert.ok(events.includes('ingest-accepted'));
  assert.ok(events.includes('ingest-noop'));
  assert.ok(events.includes('ingest-superseded'));
});
