import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, star, unstar, listStarred, onStarredChange } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('star(): rejects an empty itemId', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await assert.rejects(() => star(owner, 'bookmarked-posts', ''));
});

test('star()/listStarred(): stars an item under a given prefix and lists it back with addedAt', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await star(owner, 'bookmarked-posts', 'post-42', { data: { postId: 'post-42', title: 'Hello' } });
  const items = await listStarred(owner, 'bookmarked-posts');
  assert.equal(items.length, 1);
  assert.equal(items[0].postId, 'post-42');
  assert.equal(items[0].title, 'Hello');
  assert.ok(items[0].addedAt > 0);
});

test('star(): plain by default (no encryptFor) — a raw store read shows the plaintext value', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await star(owner, 'bookmarked-posts', 'post-42', { data: { postId: 'post-42' } });
  const raw = await owner.runtime.get(`${owner.own.id}/bookmarked-posts/post-42`);
  assert.deepEqual(raw.value, { postId: 'post-42', addedAt: raw.value.addedAt });
});

test('star(): encryptFor makes the raw store value undecryptable to a non-recipient reader', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await star(owner, 'contacts', 'some-fp', { data: { alias: 'Secret' }, encryptFor: [owner.fingerprint] });
  const raw = await owner.runtime.get(`${owner.own.id}/contacts/some-fp`);
  assert.ok(raw);
  assert.notDeepEqual(raw.value, { alias: 'Secret', addedAt: raw.value?.addedAt });
});

test('star(): re-starring the same item is idempotent, not a duplicate entry', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await star(owner, 'bookmarked-posts', 'post-42', { data: { postId: 'post-42' } });
  await star(owner, 'bookmarked-posts', 'post-42', { data: { postId: 'post-42' } });
  assert.equal((await listStarred(owner, 'bookmarked-posts')).length, 1);
});

test('unstar(): tombstones an item — listStarred()/onStarredChange() both treat it as absent', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());

  const seen = [];
  onStarredChange(owner, 'bookmarked-posts', (q) => seen.push(q.value));

  await star(owner, 'bookmarked-posts', 'post-42', { data: { postId: 'post-42' } });
  await wait();
  assert.equal((await listStarred(owner, 'bookmarked-posts')).length, 1);

  await unstar(owner, 'bookmarked-posts', 'post-42');
  await wait();

  assert.equal((await listStarred(owner, 'bookmarked-posts')).length, 0);
  assert.deepEqual(seen.at(-1), null, 'the live subscription must see the tombstone (null) as its own event');
});

test('unstar(): unstarring an item that was never starred is a harmless no-op', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await unstar(owner, 'bookmarked-posts', 'never-starred'); // must not throw
  assert.equal((await listStarred(owner, 'bookmarked-posts')).length, 0);
});

test('listStarred(): different prefixes are independent lists on the same identity', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await star(owner, 'favorite-apps', 'chat', { data: { appId: 'chat' } });
  await star(owner, 'bookmarked-posts', 'post-1', { data: { postId: 'post-1' } });

  assert.equal((await listStarred(owner, 'favorite-apps')).length, 1);
  assert.equal((await listStarred(owner, 'bookmarked-posts')).length, 1);
});

test('listStarred(): only the owner\'s own starred items are ever returned, never someone else\'s', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const other = (await Qu.create({ runtime: owner.runtime })).use(createSpacesPlugin());

  await star(owner, 'bookmarked-posts', 'post-1', { data: { postId: 'post-1' } });
  await star(other, 'bookmarked-posts', 'post-2', { data: { postId: 'post-2' } });

  const ownerItems = await listStarred(owner, 'bookmarked-posts');
  assert.equal(ownerItems.length, 1);
  assert.equal(ownerItems[0].postId, 'post-1');
});
