import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuIdentity, QuSession, userSpaceId, createSpaceACLResolver, createSpace, createSpaceAt, createACLPlugin, addToRole, removeFromRole, Qu, createSpacesPlugin } from '../src/index.js';
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

test('addToRole()/removeFromRole(): one generic function for all three roles (writers/readers/admins), other fields untouched', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessBob = new QuSession(rt, { identity: bob });

  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint], readers: [alice.fingerprint] });

  await assert.rejects(() => sessBob.publish(`${roomId}/msg1`, 'bob tries to write'), 'not yet a writer');
  await addToRole(sessAlice, roomId, 'writers', bob.fingerprint);
  await sessBob.publish(`${roomId}/msg1`, 'bob writes'); // must not throw anymore

  const afterAdd = (await sessAlice.get(roomId)).value;
  assert.deepEqual(afterAdd.readers, [alice.fingerprint], 'the readers role must be untouched by a writers-role edit');
  assert.ok(afterAdd.admins.includes(alice.fingerprint), 'admins must be untouched too');

  await removeFromRole(sessAlice, roomId, 'writers', bob.fingerprint);
  await assert.rejects(() => sessBob.publish(`${roomId}/msg2`, 'bob tries again'), 'write access was revoked');

  await addToRole(sessAlice, roomId, 'readers', bob.fingerprint);
  const afterReaderAdd = (await sessAlice.get(roomId)).value;
  assert.deepEqual(afterReaderAdd.readers.sort(), [alice.fingerprint, bob.fingerprint].sort());
});

test('addToRole()/removeFromRole(): adding an already-present fingerprint, or removing an absent one, is a no-op, not an error', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint], readers: ['*'] });

  await addToRole(sessAlice, roomId, 'writers', alice.fingerprint); // already present
  assert.deepEqual((await sessAlice.get(roomId)).value.writers, [alice.fingerprint]);

  await removeFromRole(sessAlice, roomId, 'writers', 'never-was-there');
  assert.deepEqual((await sessAlice.get(roomId)).value.writers, [alice.fingerprint]);
});

test('addToRole()/removeFromRole(): only an admin may edit the manifest — a plain writer is rejected, same as any other manifest write', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const bob = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const sessBob = new QuSession(rt, { identity: bob });

  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint, bob.fingerprint], readers: ['*'] }); // bob: writer, not admin
  await assert.rejects(() => addToRole(sessBob, roomId, 'writers', mallory.fingerprint));
});

test('addToRole()/removeFromRole() reject an unknown role name', async () => {
  const rt = makeRuntime();
  rt.use(createACLPlugin(createSpaceACLResolver(rt)));
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice });
  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint], readers: ['*'] });

  await assert.rejects(() => addToRole(sessAlice, roomId, 'owners', alice.fingerprint), /Ungültige Rolle/);
});

test('an admin can always read their own Space\'s manifest, even after removing all readers — but content stays gated by `readers` as usual', async () => {
  const rt = makeRuntime();
  const acl = createSpaceACLResolver(rt);
  rt.use(createACLPlugin(acl));
  const alice = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice, getACL: acl }); // read-ACL filtering is opt-in per Session — see the "Inbox" test above for the same pattern

  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint], readers: ['*'] });
  await sessAlice.publish(`${roomId}/msg1`, 'hello');

  await removeFromRole(sessAlice, roomId, 'readers', '*'); // go fully private, readers: []
  assert.deepEqual((await sessAlice.get(roomId)).value.readers, [], 'the manifest\'s own readers field really is empty now');

  // The admin must still be able to read the manifest itself (otherwise
  // they could never inspect/fix their own mistake, or call
  // addToRole()/removeFromRole() again — both read-then-patch it).
  const manifestAgain = await sessAlice.get(roomId);
  assert.ok(manifestAgain, 'an admin must always be able to read their own manifest');

  // Ordinary content under the space, however, is NOT exempted — it still obeys `readers` exactly as configured.
  assert.equal(await sessAlice.get(`${roomId}/msg1`), null, 'a non-listed reader (even the admin) does not get a free pass on ordinary content, only on the manifest itself');

  // And the self-lockout is genuinely recoverable, precisely because the manifest read still works:
  await addToRole(sessAlice, roomId, 'readers', alice.fingerprint);
  assert.ok(await sessAlice.get(`${roomId}/msg1`), 'once re-added as a reader, ordinary content becomes visible again');
});

test('a stranger (not admin, not reader) still cannot read a private manifest — the admin exception is not a blanket bypass', async () => {
  const rt = makeRuntime();
  const acl = createSpaceACLResolver(rt);
  rt.use(createACLPlugin(acl));
  const alice = await QuIdentity.generate();
  const mallory = await QuIdentity.generate();
  const sessAlice = new QuSession(rt, { identity: alice, getACL: acl });
  const sessMallory = new QuSession(rt, { identity: mallory, getACL: acl });

  const roomId = await createSpace(sessAlice, { writers: [alice.fingerprint], readers: ['*'] });
  await removeFromRole(sessAlice, roomId, 'readers', '*');

  assert.equal(await sessMallory.get(roomId), null, 'a non-admin stranger must not see a private manifest either');
});

test('qu.addToRole()/qu.removeFromRole(): the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });

  const room = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await room.ready;

  assert.equal(typeof alice.addToRole, 'function');
  assert.equal(typeof alice.removeFromRole, 'function');

  await alice.addToRole(room.id, 'writers', bob.fingerprint);
  await bob.get(room.id).get('msg1').put('hi'); // must not throw

  await alice.removeFromRole(room.id, 'writers', bob.fingerprint);
  await assert.rejects(() => bob.get(room.id).get('msg2').put('hi again'));
});
