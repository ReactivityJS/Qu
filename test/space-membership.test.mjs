import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, createSpacesPlugin, createSpaceMembershipPlugin, inboxId,
  ensureSpace, notifyMembers, onSpaceInvite, addSpaceMember, removeSpaceMember,
} from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

async function makePeer(runtime) {
  const qu = runtime ? await Qu.create({ runtime }) : (await Qu.create()).use(createSpacesPlugin());
  return qu.use(createSpaceMembershipPlugin());
}

test('inboxId() is deterministic per fingerprint', () => {
  assert.equal(inboxId('abc'), 'inbox-abc');
  assert.equal(inboxId('abc'), inboxId('abc'));
});

test('ensureSpace(): bootstraps a manifest granting the caller and every member write/admin access, once', async () => {
  const alice = await makePeer();
  const bob = await Qu.create({ runtime: alice.runtime });

  const spaceId = 'my-space-1';
  await ensureSpace(alice, spaceId, [bob.fingerprint]);

  const manifest = (await alice.get(spaceId)).value;
  assert.deepEqual(manifest.writers.sort(), [alice.fingerprint, bob.fingerprint].sort());
  assert.deepEqual(manifest.admins.sort(), [alice.fingerprint, bob.fingerprint].sort());
  assert.deepEqual(manifest.readers, ['*']);

  await bob.get(spaceId).get('entries/1').put('hi'); // bob really can write

  // Calling again must not overwrite an already-bootstrapped manifest.
  await alice.get(spaceId).get('meta').put({ note: 'already here' });
  await ensureSpace(alice, spaceId, [bob.fingerprint]);
  assert.equal((await alice.get(`${spaceId}/meta`)).value.note, 'already here');
});

test('ensureSpace(): readers is overridable, e.g. for a Space that should not be openly relay-forwardable', async () => {
  const alice = await makePeer();
  const bob = await Qu.create({ runtime: alice.runtime });
  const spaceId = 'my-space-2';
  await ensureSpace(alice, spaceId, [bob.fingerprint], { readers: [alice.fingerprint, bob.fingerprint] });
  assert.deepEqual((await alice.get(spaceId)).value.readers.sort(), [alice.fingerprint, bob.fingerprint].sort());
});

test('notifyMembers()/onSpaceInvite(): a member is notified of a Space they did not create, with their own view of the member list', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  const carol = await Qu.create({ runtime: alice.runtime });

  const spaceId = 'shared-space-1';
  await ensureSpace(alice, spaceId, [bob.fingerprint, carol.fingerprint]);

  const received = [];
  onSpaceInvite(bob, (q) => received.push(q.value));
  await notifyMembers(alice, spaceId, [bob.fingerprint, carol.fingerprint], { kind: 'todo-list', title: 'Groceries' });
  await wait();

  assert.equal(received.length, 1);
  assert.equal(received[0].fromFp, alice.fingerprint);
  assert.equal(received[0].id, spaceId);
  assert.equal(received[0].kind, 'todo-list');
  assert.equal(received[0].title, 'Groceries');
  assert.deepEqual(received[0].members.sort(), [alice.fingerprint, carol.fingerprint].sort(), 'bob is told about everyone EXCEPT himself');
});

test('addSpaceMember()/removeSpaceMember(): grants/revokes write access and notifies members, returning the updated list', async () => {
  const alice = await makePeer();
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime });

  const spaceId = 'shared-space-2';
  await ensureSpace(alice, spaceId, [bob.fingerprint]);

  const afterAdd = await addSpaceMember(alice, spaceId, [bob.fingerprint], carol.fingerprint);
  assert.deepEqual(afterAdd.sort(), [bob.fingerprint, carol.fingerprint].sort());
  await carol.get(spaceId).get('entries/1').put('carol can write now'); // must not throw

  const afterRemove = await removeSpaceMember(alice, spaceId, afterAdd, bob.fingerprint);
  assert.deepEqual(afterRemove, [carol.fingerprint]);
  await assert.rejects(() => bob.get(spaceId).get('entries/2').put('bob tries again'));
});

test('addSpaceMember(): adding an already-present fingerprint (or the caller) is a no-op, list returned unchanged', async () => {
  const alice = await makePeer();
  const bob = await Qu.create({ runtime: alice.runtime });
  const spaceId = 'shared-space-3';
  await ensureSpace(alice, spaceId, [bob.fingerprint]);

  const unchanged1 = await addSpaceMember(alice, spaceId, [bob.fingerprint], bob.fingerprint);
  assert.deepEqual(unchanged1, [bob.fingerprint]);

  const unchanged2 = await addSpaceMember(alice, spaceId, [bob.fingerprint], alice.fingerprint);
  assert.deepEqual(unchanged2, [bob.fingerprint]);
});

test('qu.ensureSpace()/qu.addSpaceMember()/etc.: the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  const spaceId = 'shared-space-4';

  await alice.ensureSpace(spaceId, [bob.fingerprint]);
  await bob.get(spaceId).get('entries/1').put('hi'); // bob really can write

  const received = [];
  bob.onSpaceInvite((q) => received.push(q.value));
  await alice.notifyMembers(spaceId, [bob.fingerprint], { title: 'hello' });
  await wait();
  assert.equal(received[0].title, 'hello');

  const carol = await Qu.create({ runtime: alice.runtime });
  const members = await alice.addSpaceMember(spaceId, [bob.fingerprint], carol.fingerprint);
  assert.deepEqual(members.sort(), [bob.fingerprint, carol.fingerprint].sort());
});
