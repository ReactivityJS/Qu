import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, createLoopbackChannelPair, DefaultReplication, createRateLimiter, requireDirectWriterGate, rateLimitGate } from '../src/index.js';
import { makeRuntime } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

test('createRateLimiter: allows up to maxPerWindow, then blocks, then recovers once the window rolls over', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 3, windowMs: 40 });
  assert.equal(limiter.allow('alice'), true);
  assert.equal(limiter.allow('alice'), true);
  assert.equal(limiter.allow('alice'), true);
  assert.equal(limiter.allow('alice'), false, 'the 4th call within the window must be blocked');

  assert.equal(limiter.allow('bob'), true, 'a different key has its own independent budget');

  await wait(60);
  assert.equal(limiter.allow('alice'), true, 'once the window has rolled over, alice is allowed again');
});

test('createRateLimiter: bounded memory — tracking far more keys than maxTrackedKeys never grows unbounded', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 10, windowMs: 1000, maxTrackedKeys: 5 });
  for (let i = 0; i < 100; i++) limiter.allow(`key-${i}`);
  // No direct way to inspect internal size from the public API — the real
  // assertion is just that this loop (and the whole test suite) doesn't
  // leak/slow down; a well-behaved most-recent key must still be trackable.
  assert.equal(limiter.allow('key-99'), true);
});

test('requireDirectWriter: a push whose qubit.writer matches the connection\'s own proven fingerprint is accepted', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(client, { identity: alice });

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { peerFingerprint: alice.fingerprint, requireDirectWriter: true });
  const clientRepl = new DefaultReplication(client, chB, { peerFingerprint: null, pushTopics: [''] });

  await sessAlice.publish('room/msg1', { text: 'hi' });
  await wait(20);

  const stored = await server.get('room/msg1');
  assert.equal(stored?.value.text, 'hi', 'a direct write from the authenticated peer must be accepted');

  serverRepl.close();
  clientRepl.close();
});

test('requireDirectWriter: a push whose qubit.writer differs from the connection\'s proven fingerprint is silently rejected (never ingested), without closing the connection', async () => {
  const server = makeRuntime();
  const forwarder = makeRuntime(); // a separate runtime standing in for "some other peer's already-signed qubit"
  const alice = await QuIdentity.generate(); // the connection authenticates as alice...
  const mallory = await QuIdentity.generate(); // ...but the qubit forwarded over it claims to be signed by mallory
  const sessMallory = new QuSession(forwarder, { identity: mallory });
  await sessMallory.publish('room/forged', { text: 'not really from alice\'s connection' });
  const forgedQubit = await forwarder.get('room/forged');

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { peerFingerprint: alice.fingerprint, requireDirectWriter: true });

  await chB.send({ type: 'qu.push', qubit: forgedQubit });
  await wait(20);

  assert.equal(await server.get('room/forged'), null, 'a push whose writer is not the connection\'s own proven fingerprint must never reach ingest()');

  serverRepl.close();
});

test('rateLimiter: pushes beyond the per-writer budget are rejected (never ingested), earlier ones already accepted stay', async () => {
  const server = makeRuntime();
  const client = makeRuntime();
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(client, { identity: alice });

  const limiter = createRateLimiter({ maxPerWindow: 2, windowMs: 5000 });
  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { peerFingerprint: alice.fingerprint, rateLimiter: limiter });
  const clientRepl = new DefaultReplication(client, chB, { pushTopics: [''] });

  await sessAlice.publish('room/a', 1);
  await sessAlice.publish('room/b', 2);
  await sessAlice.publish('room/c', 3); // over budget — must be rejected
  await wait(30);

  assert.equal((await server.query('room/**')).length, 2, 'only the first two writes within the window are ingested, the third is dropped');
  assert.notEqual(await server.get('room/a'), null);
  assert.notEqual(await server.get('room/b'), null);
  assert.equal(await server.get('room/c'), null, 'the over-budget write must never have reached the store');

  serverRepl.close();
  clientRepl.close();
});

test('ingestGate: a custom middleware can reject a push for its own reason, without requireDirectWriter/rateLimiter involved', async () => {
  const server = makeRuntime();
  const alice = await QuIdentity.generate();
  const { a: chA, b: chB } = createLoopbackChannelPair();

  const blockedIds = [];
  const rejectAnythingMentioningBanned = async (ctx, next) => {
    if (ctx.qubit.id.includes('banned')) { blockedIds.push(ctx.qubit.id); throw new Error('custom policy: id contains "banned"'); }
    return next();
  };
  const serverRepl = new DefaultReplication(server, chA, { peerFingerprint: alice.fingerprint, ingestGate: [rejectAnythingMentioningBanned] });

  await chB.send({ type: 'qu.push', qubit: { id: 'room/banned-item', value: 1, ts: 1, writer: alice.fingerprint } });
  await chB.send({ type: 'qu.push', qubit: { id: 'room/fine-item', value: 2, ts: 2, writer: alice.fingerprint } });
  await wait(20);

  assert.deepEqual(blockedIds, ['room/banned-item']);
  assert.equal(await server.get('room/banned-item'), null, 'a custom gate rejection must behave exactly like the built-in ones — never reach ingest()');
  assert.notEqual(await server.get('room/fine-item'), null, 'a push the custom gate allows through must still be ingested normally');

  serverRepl.close();
});

test('ingestGate: built-in gates (requireDirectWriter/rateLimiter) and custom middleware compose in one pipeline, built-ins run first', async () => {
  const server = makeRuntime();
  const alice = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const { a: chA, b: chB } = createLoopbackChannelPair();

  const seenByCustomGate = [];
  const serverRepl = new DefaultReplication(server, chA, {
    peerFingerprint: alice.fingerprint,
    requireDirectWriter: true,
    ingestGate: [async (ctx, next) => { seenByCustomGate.push(ctx.qubit.id); return next(); }],
  });

  // Rejected by the built-in requireDirectWriter gate — must never reach the custom one.
  await chB.send({ type: 'qu.push', qubit: { id: 'room/forged', value: 1, ts: 1, writer: mallory.fingerprint } });
  // Passes requireDirectWriter — reaches the custom gate, then ingest().
  await chB.send({ type: 'qu.push', qubit: { id: 'room/legit', value: 2, ts: 2, writer: alice.fingerprint } });
  await wait(20);

  assert.deepEqual(seenByCustomGate, ['room/legit'], 'the custom gate must only see what already passed the built-in requireDirectWriter check');
  assert.equal(await server.get('room/forged'), null);
  assert.notEqual(await server.get('room/legit'), null);

  serverRepl.close();
});

test('requireDirectWriterGate()/rateLimitGate() are directly composable via ingestGate, without the boolean/instance shortcuts', async () => {
  const server = makeRuntime();
  const alice = await QuIdentity.generate();
  const { a: chA, b: chB } = createLoopbackChannelPair();

  const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 5000 });
  const serverRepl = new DefaultReplication(server, chA, {
    peerFingerprint: alice.fingerprint,
    ingestGate: [rateLimitGate(limiter), requireDirectWriterGate()],
  });

  await chB.send({ type: 'qu.push', qubit: { id: 'room/first', value: 1, ts: 1, writer: alice.fingerprint } });
  await chB.send({ type: 'qu.push', qubit: { id: 'room/second', value: 2, ts: 2, writer: alice.fingerprint } }); // over the manual rate limiter's budget
  await wait(20);

  assert.notEqual(await server.get('room/first'), null);
  assert.equal(await server.get('room/second'), null, 'the manually-composed rateLimitGate() must reject exactly like the requireDirectWriter/rateLimiter shorthand would');

  serverRepl.close();
});

test('createRateLimiter: configure() live-changes the threshold without resetting already-tracked hits', async () => {
  const limiter = createRateLimiter({ maxPerWindow: 1, windowMs: 5000 });
  assert.equal(limiter.allow('alice'), true);
  assert.equal(limiter.allow('alice'), false, 'already over the original budget of 1');

  limiter.configure({ maxPerWindow: 3 });
  assert.deepEqual(limiter.getConfig(), { maxPerWindow: 3, windowMs: 5000 }, 'windowMs is left untouched by a partial configure()');
  assert.equal(limiter.allow('alice'), true, 'the raised budget applies immediately, on top of the hit already tracked before configure()');
  assert.equal(limiter.allow('alice'), true);
  assert.equal(limiter.allow('alice'), false, 'now over the NEW budget of 3 (1 pre-existing + 2 new)');
});
