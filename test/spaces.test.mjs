import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, userSpaceId, createSpaceACLResolver, createSpace, createSpaceAt, createACLPlugin } from '../src/index.js';
import { makeRuntime } from './helpers.mjs';

test('an explicit write-ACL denies a non-writer', async () => {
  const rt = makeRuntime();
  const alice = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const acl = { 'chat/room1/locked': { writers: [alice.fingerprint], readers: ['*'] } };
  rt.use(createACLPlugin(async (id) => acl[id] ?? null));

  const sessMallory = new QuSession(rt, { identity: mallory });
  await assert.rejects(() => sessMallory.publish('chat/room1/locked', 'mallory writes'));
});

test('User-Space: owner can write with no manifest present, and can never be locked out by their own manifest', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessMallory = new QuSession(rt, { identity: mallory });

  await sessAlice.publish(`${userSpaceId(alice.fingerprint)}/alias`, 'alice'); // no manifest exists yet — must still work

  await assert.rejects(() => sessMallory.publish(`${userSpaceId(alice.fingerprint)}/alias`, 'hacked'));

  // A manifest that tries to exclude the owner is overridden by the structural guarantee.
  await sessAlice.publish(userSpaceId(alice.fingerprint), { admins: [alice.fingerprint], writers: [], readers: ['*'] });
  await sessAlice.publish(`${userSpaceId(alice.fingerprint)}/notes/1`, 'still mine'); // must not throw
});

test('generic Space: first-write-wins bootstrap, then the manifest is enforced, and only admins may update it', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessBob = new QuSession(rt, { identity: bob });

  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint], readers: ['*'] });

  await assert.rejects(() => sessBob.publish(`${roomId}/msg1`, 'bob tries to post'));
  await assert.rejects(() => sessBob.publish(roomId, { admins: [bob.fingerprint], writers: ['*'], readers: ['*'] }));
});

test('createSpaceAt(): same manifest-bootstrap as createSpace(), but at a caller-chosen fixed id — for one well-known App-Space per app, not a fresh random room each time', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessBob = new QuSession(rt, { identity: bob });
  const sessMallory = new QuSession(rt, { identity: mallory });

  const APP_SPACE = 'my-fixed-app-space';
  const returnedId = await createSpaceAt(sessAlice, APP_SPACE, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] });
  assert.equal(returnedId, APP_SPACE, 'resolves with the exact id given, not a generated one');

  await sessBob.publish(`${APP_SPACE}/entries/1`, 'bob writes'); // a listed writer
  await assert.rejects(() => sessMallory.publish(`${APP_SPACE}/entries/2`, 'mallory writes'), 'not a listed writer');
  await assert.rejects(() => sessBob.publish(APP_SPACE, { admins: [bob.fingerprint], writers: ['*'], readers: ['*'] }), 'a writer, not an admin, cannot rewrite the manifest itself');
});

test('Inbox is not a framework concept — it is a Space (writers:[*], readers:[owner]) discovered via a profile reference', async () => {
  const rt = makeRuntime();
  const acl = createSpaceACLResolver(rt);
  rt.use(createACLPlugin(acl));
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice, getACL: acl });
  const sessBob = new QuSession(rt, { identity: bob, getACL: acl });
  const sessMallory = new QuSession(rt, { identity: mallory, getACL: acl });

  const inboxId = await createSpace(sessAlice, { writers: ['*'], readers: [alice.fingerprint] });
  await sessAlice.publish(userSpaceId(alice.fingerprint), { admins: [alice.fingerprint], writers: [], readers: ['*'] });
  await sessAlice.publish(`${userSpaceId(alice.fingerprint)}/links`, { inbox: inboxId });

  await sessAlice.trustPeer(bob.fingerprint, (await bob.exportKeys()).encPub);
  await sessBob.trustPeer(alice.fingerprint, (await alice.exportKeys()).encPub);
  await sessBob.publish(`${inboxId}/msg1`, { text: 'hi alice, from bob' }, { encryptFor: [alice.fingerprint, bob.fingerprint] });

  const profileLinks = await sessBob.get(`${userSpaceId(alice.fingerprint)}/links`);
  assert.equal(profileLinks.value.inbox, inboxId, 'inbox is found via the profile reference, not a hardcoded path');

  const aliceView = await sessAlice.query(`${inboxId}/**`);
  const malloryView = await sessMallory.query(`${inboxId}/**`);
  assert.equal(aliceView[0].value.text, 'hi alice, from bob');
  assert.equal(malloryView.length, 0, 'non-owner cannot read inbox contents (space readers ACL)');
});
