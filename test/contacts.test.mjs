import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, createContactsPlugin, addContact, removeContact, listContacts, onContactsChange } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('addContact(): rejects an invalid fingerprint', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await assert.rejects(() => addContact(owner, 'not-a-real-fingerprint'));
});

test('addContact()/listContacts(): adds a contact and lists it back with alias/addedAt', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create();

  await addContact(owner, bob.fingerprint, { alias: 'Bob from work' });
  const contacts = await listContacts(owner);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].fingerprint, bob.fingerprint);
  assert.equal(contacts[0].alias, 'Bob from work');
  assert.ok(contacts[0].addedAt > 0);
});

test('addContact(): is encrypted-to-self — a raw store read never shows the plaintext contact info', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create();
  await addContact(owner, bob.fingerprint, { alias: 'Secret Bob' });

  const raw = await owner.runtime.get(`${owner.own.id}/contacts/${bob.fingerprint}`);
  assert.ok(raw);
  assert.notDeepEqual(raw.value, { fingerprint: bob.fingerprint, alias: 'Secret Bob', addedAt: raw.value?.addedAt });
});

test('addContact(): re-adding the same fingerprint overwrites (idempotent), not a duplicate entry', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create();

  await addContact(owner, bob.fingerprint, { alias: 'First alias' });
  await addContact(owner, bob.fingerprint, { alias: 'Updated alias' });
  const contacts = await listContacts(owner);

  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].alias, 'Updated alias');
});

test('removeContact(): tombstones a contact — listContacts()/onContactsChange() both treat it as absent', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const bob = await Qu.create();

  const seen = [];
  onContactsChange(owner, (q) => seen.push(q.value));

  await addContact(owner, bob.fingerprint);
  await wait();
  assert.equal((await listContacts(owner)).length, 1);

  await removeContact(owner, bob.fingerprint);
  await wait();

  assert.equal((await listContacts(owner)).length, 0);
  assert.deepEqual(seen.at(-1), null, 'the live subscription must see the tombstone (null) as its own event');
});

test('removeContact(): removing an unknown fingerprint is a harmless no-op', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const stranger = await Qu.create();
  await removeContact(owner, stranger.fingerprint); // must not throw
  assert.equal((await listContacts(owner)).length, 0);
});

test('listContacts(): only the owner\'s own contacts are ever returned, never someone else\'s', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const other = (await Qu.create({ runtime: owner.runtime })).use(createSpacesPlugin());
  const bob = await Qu.create();
  const carol = await Qu.create();

  await addContact(owner, bob.fingerprint);
  await addContact(other, carol.fingerprint);

  const ownerContacts = await listContacts(owner);
  assert.equal(ownerContacts.length, 1);
  assert.equal(ownerContacts[0].fingerprint, bob.fingerprint);
});

test('qu.addContact()/qu.removeContact()/etc.: the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createContactsPlugin());
  const bob = await Qu.create();

  await owner.addContact(bob.fingerprint, { alias: 'Bob' });
  const contacts = await owner.listContacts();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].alias, 'Bob');

  await owner.removeContact(bob.fingerprint);
  assert.equal((await owner.listContacts()).length, 0);
});
