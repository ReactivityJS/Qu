import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, onDebug } from '../src/index.js';
import { makeRuntime, withSilencedConsoleError } from './helpers.mjs';

test('two independent Sessions on one shared Runtime sign only with their own identity', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessBob = new QuSession(rt, { identity: bob });

  const rA = await sessAlice.publish('shared/note1', 'from alice');
  const rB = await sessBob.publish('shared/note2', 'from bob');

  assert.equal(rA.qubit.writer, alice.fingerprint);
  assert.equal(rB.qubit.writer, bob.fingerprint);
  assert.notEqual(rA.qubit.writer, rB.qubit.writer);
});

test('encryption: only an addressed recipient can decrypt; Core/Runtime never sees plaintext', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessBob = new QuSession(rt, { identity: bob });
  const sessMallory = new QuSession(rt, { identity: mallory });

  await sessAlice.trustPeer(bob.fingerprint, (await bob.exportKeys()).encPub);
  await sessAlice.publish('dm/secret1', { text: 'only for bob' }, { encryptFor: [alice.fingerprint, bob.fingerprint] });

  const bobView = await sessBob.get('dm/secret1');
  const malloryView = await sessMallory.get('dm/secret1');
  const raw = await rt.get('dm/secret1');

  assert.equal(bobView.value.text, 'only for bob');
  assert.equal(malloryView.value, undefined);
  assert.equal(malloryView.encrypted, true);
  assert.equal(raw.value.__qu_enc, 1);
  assert.ok(!JSON.stringify(raw.value).includes('only for bob'), 'ciphertext must not leak the plaintext');
});

test('resolveRefs() follows a QuBit\'s refs to the QuBits they point at', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  await session.publish('files/abc123', { name: 'report.pdf' });
  const { qubit: msg } = await session.publish('chat/room1/msg1', { text: 'see attached' }, { refs: ['files/abc123'] });

  const [resolved] = await session.resolveRefs(msg);
  assert.equal(resolved.value.name, 'report.pdf');
});

test('session.on(): a throwing/rejecting async callback (e.g. a UI render function) does not silently vanish — and does not block later messages', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  const errorsSeen = [];
  const off = onDebug((e) => { if (e.scope === 'session' && e.event === 'on-callback-error') errorsSeen.push(e); });

  const rendered = [];
  session.on('room/**', async (q) => {
    if (q.value === 'boom') throw new Error('render exploded');
    rendered.push(q.value);
  });

  await withSilencedConsoleError(async () => {
    await session.publish('room/1', 'boom');
    await new Promise((r) => setTimeout(r, 20));
    await session.publish('room/2', 'still works');
    await new Promise((r) => setTimeout(r, 20));
  });

  off();
  assert.deepEqual(rendered, ['still works'], 'the second message must still render after the first one\'s callback threw');
  assert.equal(errorsSeen.length, 1, 'the failure must be observable via the debug system, not silently swallowed');
});

test('session.on() with initial/once decrypts every delivered qubit, matching query()\'s existing behaviour', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const session = new QuSession(rt, { identity: alice });

  await session.publish('room/a', 'first', { ts: 10 });
  await session.publish('room/b', 'second', { ts: 20 });

  const seenOnce = [];
  session.on('room/**', (q) => seenOnce.push(q.value), { once: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seenOnce, ['first', 'second']);

  const seenInitial = [];
  session.on('room/**', (q) => seenInitial.push(q.value), { initial: true });
  await new Promise((r) => setTimeout(r, 20));
  await session.publish('room/c', 'third', { ts: 30 });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seenInitial, ['first', 'second', 'third']);
});
