import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoopbackChannelPair } from '../src/core/channel.js';
import { sendRoutedEvent, onRoutedEvent } from '../src/network/routed-events.js';

test('sendRoutedEvent()/onRoutedEvent(): delivers only messages matching the given event name', async () => {
  const { a, b } = createLoopbackChannelPair();
  const seen = [];
  onRoutedEvent(b, 'ping', (msg) => seen.push(msg));

  await sendRoutedEvent(a, 'bob-fp', 'ping', { n: 1 });
  await sendRoutedEvent(a, 'bob-fp', 'pong', { n: 2 }); // different event — must be ignored by this listener
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, 'ping');
  assert.equal(seen[0].payload.n, 1);
  assert.equal(seen[0].to, 'bob-fp');
});

test('onRoutedEvent() unsubscribe stops further delivery', async () => {
  const { a, b } = createLoopbackChannelPair();
  const seen = [];
  const off = onRoutedEvent(b, 'x', (msg) => seen.push(msg));
  await sendRoutedEvent(a, 'fp', 'x', {});
  await new Promise((r) => setTimeout(r, 10));
  off();
  await sendRoutedEvent(a, 'fp', 'x', {});
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 1);
});

test('a plain qu.push message (normal replication) is not mistaken for a routed event', async () => {
  const { a, b } = createLoopbackChannelPair();
  const seen = [];
  onRoutedEvent(b, 'anything', (msg) => seen.push(msg));
  await a.send({ type: 'qu.push', qubit: { id: 'x', value: 1, ts: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.length, 0);
});
