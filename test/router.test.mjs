import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/network/router.js';

const qubit = (id) => ({ id, value: 'x', ts: Date.now() });

test('a mirror route always receives matching qubits, regardless of any sync route or metric', () => {
  const router = new Router();
  router.addRoute({ channelId: 'mirror-1', channel: {}, pushTopics: ['room/'], role: 'mirror' });
  router.addRoute({ channelId: 'sync-1', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 5 });

  const chosen = router.resolve(qubit('room/msg1'));
  assert.ok(chosen.some((r) => r.channelId === 'mirror-1'));
});

test('ungrouped sync routes are never treated as alternatives to each other — both are included, by design (safe default)', () => {
  const router = new Router();
  router.addRoute({ channelId: 'a', channel: {}, pushTopics: ['room/'], role: 'sync', metric: 1 });
  router.addRoute({ channelId: 'b', channel: {}, pushTopics: ['room/'], role: 'sync', metric: 100 });

  const chosen = router.resolve(qubit('room/msg1'));
  assert.equal(chosen.length, 2, 'no group was assigned, so both must be included — routing optimization is opt-in, not inferred');
});

test('grouped sync routes compete: only the lowest metric is chosen', () => {
  const router = new Router();
  router.addRoute({ channelId: 'direct', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 10, transport: 'webrtc' });
  router.addRoute({ channelId: 'relay', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 100, transport: 'relay' });

  const chosen = router.resolve(qubit('room/msg1'));
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].channelId, 'direct');
});

test('a tie within a group includes all tied routes ("identische Metrik -> alle Wege")', () => {
  const router = new Router();
  router.addRoute({ channelId: 'a', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 10 });
  router.addRoute({ channelId: 'b', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 10 });
  router.addRoute({ channelId: 'c', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 20 });

  const chosen = router.resolve(qubit('room/msg1'));
  const ids = chosen.map((r) => r.channelId).sort();
  assert.deepEqual(ids, ['a', 'b']);
});

test('updateMetric() changes the outcome live — e.g. a direct route degrading lets the relay take over without re-registering anything', () => {
  const router = new Router();
  router.addRoute({ channelId: 'direct', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 5 });
  router.addRoute({ channelId: 'relay', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 50 });

  assert.equal(router.resolve(qubit('room/x'))[0].channelId, 'direct');

  router.updateMetric('direct', 999); // e.g. RTT sampling detected the direct path degraded
  assert.equal(router.resolve(qubit('room/x'))[0].channelId, 'relay');
});

test('routes only apply to matching pushTopics — an unrelated topic gets nothing', () => {
  const router = new Router();
  router.addRoute({ channelId: 'a', channel: {}, pushTopics: ['room/'], role: 'mirror' });
  assert.equal(router.resolve(qubit('other/x')).length, 0);
});

test('removeRoute() takes a channel out of consideration entirely', () => {
  const router = new Router();
  router.addRoute({ channelId: 'a', channel: {}, pushTopics: ['room/'], role: 'mirror' });
  router.removeRoute('a');
  assert.equal(router.resolve(qubit('room/x')).length, 0);
});

test('isChosen() matches resolve() for a single route', () => {
  const router = new Router();
  router.addRoute({ channelId: 'direct', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 1 });
  router.addRoute({ channelId: 'relay', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 2 });

  assert.equal(router.isChosen('direct', qubit('room/x')), true);
  assert.equal(router.isChosen('relay', qubit('room/x')), false);
});

test('independent groups (different peers) never compete with each other', () => {
  const router = new Router();
  router.addRoute({ channelId: 'to-bob', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:bob', metric: 1 });
  router.addRoute({ channelId: 'to-carol', channel: {}, pushTopics: ['room/'], role: 'sync', group: 'peer:carol', metric: 999 });

  const chosen = router.resolve(qubit('room/x')).map((r) => r.channelId).sort();
  assert.deepEqual(chosen, ['to-bob', 'to-carol']);
});
