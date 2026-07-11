import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import {
  createTodoList, canWrite, grantWriteAccess,
  addItem, setItemDone, deleteItem, listItems, onItemsChange,
} from './todo-lib.mjs';

test('owner can write immediately; a stranger cannot until granted access', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const stranger = await Qu.create({ runtime: owner.runtime }); // same "relay", separate identity

  const listId = await createTodoList(owner);
  assert.equal(await canWrite(owner, listId), true);
  assert.equal(await canWrite(stranger, listId), false);

  await assert.rejects(() => addItem(stranger, listId, 'sneaky item'));

  await grantWriteAccess(owner, listId, stranger.fingerprint);
  assert.equal(await canWrite(stranger, listId), true);
  await addItem(stranger, listId, 'now allowed'); // must not throw anymore
});

test('granting access preserves the existing writers instead of replacing them', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const alice = await Qu.create({ runtime: owner.runtime });
  const bob = await Qu.create({ runtime: owner.runtime });

  const listId = await createTodoList(owner);
  await grantWriteAccess(owner, listId, alice.fingerprint);
  await grantWriteAccess(owner, listId, bob.fingerprint);

  const manifest = await owner.get(listId);
  assert.ok(manifest.value.writers.includes(owner.fingerprint));
  assert.ok(manifest.value.writers.includes(alice.fingerprint));
  assert.ok(manifest.value.writers.includes(bob.fingerprint));
});

test('a writer who is not an admin cannot grant access to someone else', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const alice = await Qu.create({ runtime: owner.runtime });
  const listId = await createTodoList(owner);
  await grantWriteAccess(owner, listId, alice.fingerprint); // alice can now write items, but is not an admin

  await assert.rejects(() => grantWriteAccess(alice, listId, 'someone-else-fp'));
});

test('items: add, toggle done, delete (tombstone, filtered out of listItems), live updates', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const listId = await createTodoList(owner);

  const seen = [];
  onItemsChange(owner, listId, (q) => seen.push(q.value.text));

  const { qubit: item1 } = await addItem(owner, listId, 'Milch kaufen');
  await addItem(owner, listId, 'Brot kaufen');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen, ['Milch kaufen', 'Brot kaufen']);

  let items = await listItems(owner, listId);
  assert.equal(items.length, 2);
  assert.equal(items[0].value.done, false);

  await setItemDone(owner, item1.id, true);
  items = await listItems(owner, listId);
  assert.equal(items.find((i) => i.id === item1.id).value.done, true);

  await deleteItem(owner, item1.id);
  items = await listItems(owner, listId);
  assert.equal(items.length, 1, 'a deleted item must be filtered out');
  assert.equal(items[0].value.text, 'Brot kaufen');
});

test('any writer can toggle an item another writer created — shared-list semantics, not per-author ownership', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const alice = await Qu.create({ runtime: owner.runtime });
  const listId = await createTodoList(owner);
  await grantWriteAccess(owner, listId, alice.fingerprint);

  const { qubit: item } = await addItem(owner, listId, 'shared item');
  await setItemDone(alice, item.id, true); // alice didn't create it, but is a writer on the list
  const items = await listItems(alice, listId);
  assert.equal(items[0].value.done, true);
});
