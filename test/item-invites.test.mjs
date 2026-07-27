import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, createSpacesPlugin,
  itemInviteBoxId, inviteToItem, onItemInvite, createItemInvitesPlugin, createItemInvitePushRule,
} from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('itemInviteBoxId() is deterministic per fingerprint, distinct from space-membership.js\'s inbox-<fp>', () => {
  assert.equal(itemInviteBoxId('abc'), 'item-invites/abc');
  assert.equal(itemInviteBoxId('abc'), itemInviteBoxId('abc'));
  assert.notEqual(itemInviteBoxId('abc'), `inbox-abc`);
});

test('inviteToItem()/onItemInvite(): a recipient is notified of an item they were never given Space access to', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });

  const received = [];
  onItemInvite(bob, (q) => received.push(q.value));
  await inviteToItem(alice, 'some-space-id/things/42', bob.fingerprint, { kind: 'Karteikarte' });
  await wait();

  assert.equal(received.length, 1);
  assert.equal(received[0].fromFp, alice.fingerprint);
  assert.equal(received[0].itemId, 'some-space-id/things/42');
  assert.equal(received[0].kind, 'Karteikarte');
});

test('inviteToItem(): two different recipients never collide, even for the same item', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const carol = await Qu.create({ runtime: alice.runtime });

  await inviteToItem(alice, 'space/items/1', bob.fingerprint);
  await inviteToItem(alice, 'space/items/1', carol.fingerprint);

  const bobReceived = [];
  const carolReceived = [];
  onItemInvite(bob, (q) => bobReceived.push(q.value));
  onItemInvite(carol, (q) => carolReceived.push(q.value));
  await wait();

  assert.equal(bobReceived.length, 1);
  assert.equal(carolReceived.length, 1);
});

test('qu.inviteToItem()/qu.onItemInvite(): the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createItemInvitesPlugin());
  const bob = (await Qu.create({ runtime: alice.runtime })).use(createItemInvitesPlugin());

  const received = [];
  bob.onItemInvite((q) => received.push(q.value));
  await alice.inviteToItem('space/items/9', bob.fingerprint, { kind: 'Notiz' });
  await wait();

  assert.equal(received[0].kind, 'Notiz');
});

test('createItemInvitePushRule(): pattern matches the exact id shape inviteToItem() produces, and resolveRecipients() extracts the right fingerprint', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const { qubit } = await inviteToItem(alice, 'space/items/1', bob.fingerprint, { kind: 'Termin' });

  const rule = createItemInvitePushRule();
  const segments = qubit.id.split('/');
  assert.equal(segments[0], 'item-invites');
  assert.equal(segments[1], bob.fingerprint);

  const recipients = await rule.resolveRecipients(qubit, alice.runtime);
  assert.deepEqual(recipients, [bob.fingerprint]);

  const payloadWithSender = await rule.buildPayload(qubit, 'Alice');
  assert.match(payloadWithSender.body, /Alice/);
  assert.match(payloadWithSender.body, /Termin/);

  const payloadNoSender = await rule.buildPayload(qubit, null);
  assert.doesNotMatch(payloadNoSender.body, /Alice/);
  assert.match(payloadNoSender.body, /Termin/);
});

test('createItemInvitePushRule(): buildPayload() never mentions a kind that was never set', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create({ runtime: alice.runtime });
  const { qubit } = await inviteToItem(alice, 'space/items/2', bob.fingerprint); // no kind

  const rule = createItemInvitePushRule();
  const payload = await rule.buildPayload(qubit, 'Alice');
  assert.equal(payload.body, 'Alice hat dir etwas geteilt');
});
