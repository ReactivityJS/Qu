import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, createSpacesPlugin, createSpaceMembershipPlugin, createNotificationsPlugin,
  notifyUser, onNotification, ensureSpace, notifyMembers, onSpaceInvite,
} from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

async function makePeer(runtime) {
  const qu = runtime ? await Qu.create({ runtime }) : (await Qu.create()).use(createSpacesPlugin());
  return qu.use(createSpaceMembershipPlugin()).use(createNotificationsPlugin());
}

test('notifyUser()/onNotification(): a delivered notification carries the sender fingerprint and the caller-supplied payload', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  const received = [];
  onNotification(bob, (q) => received.push(q.value));
  await notifyUser(alice, bob.fingerprint, { appId: 'forum', kind: 'reply', message: 'Someone replied to your post' });
  await wait();

  assert.equal(received.length, 1);
  assert.equal(received[0].fromFp, alice.fingerprint);
  assert.equal(received[0].appId, 'forum');
  assert.equal(received[0].kind, 'reply');
  assert.equal(received[0].message, 'Someone replied to your post');
});

test('notifyUser(): repeated notifications from the SAME sender never overwrite each other (unlike space-membership.js\'s invite slot)', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  const received = [];
  onNotification(bob, (q) => received.push(q.value));
  await notifyUser(alice, bob.fingerprint, { kind: 'comment', message: 'first' });
  await notifyUser(alice, bob.fingerprint, { kind: 'comment', message: 'second' });
  await wait();

  assert.equal(received.length, 2, 'both notifications must be delivered as distinct entries, not one overwriting the other');
  assert.deepEqual(received.map((n) => n.message).sort(), ['first', 'second']);
});

test('onNotification(): only the caller\'s OWN inbox is read, never someone else\'s', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);
  const carol = await makePeer(alice.runtime);

  const bobReceived = [];
  onNotification(bob, (q) => bobReceived.push(q.value));
  await notifyUser(alice, carol.fingerprint, { kind: 'mention', message: 'for carol only' });
  await wait();

  assert.equal(bobReceived.length, 0, 'bob must not see a notification addressed to carol');
});

test('notifyUser(): the payload field cannot spoof fromFp — the module always sets it to the actual caller', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  const received = [];
  onNotification(bob, (q) => received.push(q.value));
  await notifyUser(alice, bob.fingerprint, { fromFp: 'someone-else-entirely', message: 'x' });
  await wait();

  assert.equal(received[0].fromFp, alice.fingerprint, 'fromFp is always overwritten with the real caller fingerprint');
});

test('onNotification()/onSpaceInvite(): both read from the same per-identity inbox, on independent subtrees', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  const notifications = [];
  const invites = [];
  onNotification(bob, (q) => notifications.push(q.value));
  onSpaceInvite(bob, (q) => invites.push(q.value));

  await notifyUser(alice, bob.fingerprint, { kind: 'like', message: 'liked your post' });
  await ensureSpace(alice, 'shared-space-notif-1', [bob.fingerprint]);
  await notifyMembers(alice, 'shared-space-notif-1', [bob.fingerprint], { kind: 'todo-list' });
  await wait();

  assert.equal(notifications.length, 1, 'a space invite must not also show up as a notification');
  assert.equal(invites.length, 1, 'a notification must not also show up as a space invite');
});

test('qu.notifyUser()/qu.onNotification(): the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const alice = await makePeer();
  const bob = await makePeer(alice.runtime);

  const received = [];
  bob.onNotification((q) => received.push(q.value));
  await alice.notifyUser(bob.fingerprint, { kind: 'ping', message: 'hello' });
  await wait();

  assert.equal(received[0].message, 'hello');
  assert.equal(received[0].fromFp, alice.fingerprint);
});
