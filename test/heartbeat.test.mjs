import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat, HEARTBEAT_PING, HEARTBEAT_PONG } from '../src/core/heartbeat.js';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('createHeartbeat(): a peer that answers every ping never times out', async () => {
  const sentByA = [];
  let timedOut = false;
  const b = { handleIncoming: null }; // filled below, so a's send() can hand straight to b

  const a = createHeartbeat({
    send: (msg) => { sentByA.push(msg); b.handleIncoming(msg); },
    onTimeout: () => { timedOut = true; },
    intervalMs: 30,
  });
  // b is the "always answers" peer — its own heartbeat instance just
  // echoes pongs back through a's handleIncoming(), exactly like two real
  // transports wired together.
  const bHeartbeat = createHeartbeat({
    send: (msg) => a.handleIncoming(msg),
    onTimeout: () => { throw new Error('b should never see a timeout in this test'); },
    intervalMs: 30,
  });
  b.handleIncoming = bHeartbeat.handleIncoming;

  a.start();
  await wait(140); // several ping/pong round trips
  a.stop();
  bHeartbeat.stop();

  assert.equal(timedOut, false, 'a peer that always answers pings must never trigger onTimeout()');
  assert.ok(sentByA.some((m) => m.type === HEARTBEAT_PING), 'at least one ping must have been sent');
});

test('createHeartbeat(): a silent peer triggers onTimeout() within roughly 2 intervals', async () => {
  let timedOut = false;
  const hb = createHeartbeat({
    send: () => {}, // nobody ever answers
    onTimeout: () => { timedOut = true; },
    intervalMs: 20,
  });

  hb.start();
  await wait(30); // one interval — first ping just went out, no timeout yet
  assert.equal(timedOut, false, 'must not time out before a second ping has had a chance to go unanswered');
  await wait(40); // well into the second interval — the first ping was never answered
  hb.stop();

  assert.equal(timedOut, true, 'a peer that never answers must eventually trigger onTimeout()');
});

test('createHeartbeat(): handleIncoming() answers a ping with a pong and reports it as handled', () => {
  const sent = [];
  const hb = createHeartbeat({ send: (msg) => sent.push(msg), onTimeout: () => {} });

  const handledPing = hb.handleIncoming({ type: HEARTBEAT_PING });
  assert.equal(handledPing, true);
  assert.deepEqual(sent, [{ type: HEARTBEAT_PONG }]);

  const handledOther = hb.handleIncoming({ type: 'qu.route', to: 'x' });
  assert.equal(handledOther, false, 'a non-heartbeat message must be reported as NOT handled, so the caller forwards it');
});

test('createHeartbeat(): stop() prevents any further timeout even if a ping was already unanswered', async () => {
  let timedOut = false;
  const hb = createHeartbeat({ send: () => {}, onTimeout: () => { timedOut = true; }, intervalMs: 15 });
  hb.start();
  await wait(20); // first ping sent, unanswered
  hb.stop();
  await wait(40); // long past when a timeout would otherwise have fired
  assert.equal(timedOut, false, 'stop() must prevent the interval from ever firing again');
});
