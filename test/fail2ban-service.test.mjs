import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, createLoopbackChannelPair, DefaultReplication } from '../src/index.js';
import { canonical } from '../src/core/sign.js';
import { createFail2banService } from '../relay/services/fail2ban.mjs';
import { makeRuntime, withSilencedConsoleError } from './helpers.mjs';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** A structurally valid but forged (tampered-signature) qubit — makeRuntime()'s createVerifyPlugin() rejects it, same as a real attacker's malformed push, without needing a real ACL setup. */
async function forgedQubit(identity, id) {
  const qubit = { id, value: 'x', ts: Date.now() + Math.random() };
  qubit.writer = identity.fingerprint;
  qubit.pubKey = await identity.exportPublicSigningKey();
  const validSig = await identity.sign(canonical(qubit));
  qubit.sig = `${validSig.slice(0, -2)}00`; // corrupt the last byte — verifySignature() must reject this
  return qubit;
}

test('fail2ban: bans a fingerprint after maxFailuresPerWindow rejected pushes, blocking even a subsequent VALID push while banned', async () => {
  const fail2ban = createFail2banService({ maxFailuresPerWindow: 3, windowMs: 5000, banDurationMs: 5000 });
  const server = makeRuntime();
  const client = makeRuntime();
  const attacker = await QuIdentity.generate();

  const { a: chA, b: chB } = createLoopbackChannelPair();
  const serverRepl = new DefaultReplication(server, chA, { peerFingerprint: attacker.fingerprint, ingestGate: fail2ban.ingestGates });
  const clientRepl = new DefaultReplication(client, chB, { peerFingerprint: null, pushTopics: [''] });
  const off = fail2ban.attachDebugBus();

  // Raw `qu.push` messages sent directly over the channel (bypassing
  // clientRepl/QuSession entirely) — a legitimate client's OWN local
  // ingest() would already reject a forged signature before ever
  // forwarding it, so simulating "a malicious peer sends a forged push
  // straight over the wire" needs to skip the normal publish() path.
  await withSilencedConsoleError(async () => {
    for (let i = 0; i < 3; i++) {
      chB.send({ type: 'qu.push', qubit: await forgedQubit(attacker, `x/${i}`) });
      await wait(20);
    }
  });
  assert.equal(fail2ban.isBanned(attacker.fingerprint), true, 'the 3rd rejected push must trigger the ban');

  // Now even a genuinely VALID push from the same (now-banned) fingerprint
  // is blocked — the gate rejects it BEFORE verify/ACL even run.
  const sess = new QuSession(client, { identity: attacker });
  await withSilencedConsoleError(async () => {
    await sess.publish('room/legit', { text: 'hi' });
  });
  await wait(20);
  assert.equal(await server.get('room/legit'), null, 'a banned fingerprint\'s otherwise-valid push must still be rejected');

  off();
  serverRepl.close();
  clientRepl.close();
});

test('fail2ban: a ban expires on its own after banDurationMs', async () => {
  const fail2ban = createFail2banService({ maxFailuresPerWindow: 1, windowMs: 5000, banDurationMs: 60 });
  fail2ban.recordFailure('some-key');
  assert.equal(fail2ban.isBanned('some-key'), true);
  await wait(150);
  assert.equal(fail2ban.isBanned('some-key'), false, 'the ban must lapse on its own once banDurationMs has passed');
});

test('fail2ban: onAdminEvent("unban") lifts a ban immediately, without waiting for it to expire', () => {
  const fail2ban = createFail2banService({ maxFailuresPerWindow: 1, windowMs: 5000, banDurationMs: 60_000 });
  fail2ban.recordFailure('some-key');
  assert.equal(fail2ban.isBanned('some-key'), true);

  const handled = fail2ban.onAdminEvent('unban', { key: 'some-key' });
  assert.equal(handled, true);
  assert.equal(fail2ban.isBanned('some-key'), false);
});

test('fail2ban: onAdminEvent ignores an unknown action or a missing key, without throwing', () => {
  const fail2ban = createFail2banService();
  assert.equal(fail2ban.onAdminEvent('not-a-real-action', { key: 'x' }), false);
  assert.equal(fail2ban.onAdminEvent('unban', {}), false);
});
