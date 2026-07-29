import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, createFavoritesPlugin, addFavorite, removeFavorite, listFavorites, onFavoritesChange } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

test('addFavorite(): rejects an empty appId', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await assert.rejects(() => addFavorite(owner, ''));
});

test('addFavorite()/listFavorites(): favorites an app and lists it back', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await addFavorite(owner, 'chat');
  const favorites = await listFavorites(owner);
  assert.deepEqual(favorites, ['chat']);
});

test('addFavorite(): is plain, not encrypted — a raw store read shows the plaintext appId', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await addFavorite(owner, 'chat');
  const raw = await owner.runtime.get(`${owner.own.id}/favorite-apps/chat`);
  assert.deepEqual(raw.value, { appId: 'chat', addedAt: raw.value.addedAt });
});

test('addFavorite(): re-favoriting the same app is idempotent, not a duplicate entry', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await addFavorite(owner, 'chat');
  await addFavorite(owner, 'chat');
  const favorites = await listFavorites(owner);
  assert.equal(favorites.length, 1);
});

test('removeFavorite(): tombstones a favorite — listFavorites()/onFavoritesChange() both treat it as absent', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());

  const seen = [];
  onFavoritesChange(owner, (q) => seen.push(q.value));

  await addFavorite(owner, 'chat');
  await wait();
  assert.deepEqual(await listFavorites(owner), ['chat']);

  await removeFavorite(owner, 'chat');
  await wait();

  assert.equal((await listFavorites(owner)).length, 0);
  assert.deepEqual(seen.at(-1), null, 'the live subscription must see the tombstone (null) as its own event');
});

test('removeFavorite(): removing an app that was never favorited is a harmless no-op', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await removeFavorite(owner, 'chat'); // must not throw
  assert.equal((await listFavorites(owner)).length, 0);
});

test('listFavorites(): only the owner\'s own favorites are ever returned, never someone else\'s', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const other = (await Qu.create({ runtime: owner.runtime })).use(createSpacesPlugin());

  await addFavorite(owner, 'chat');
  await addFavorite(other, 'forum');

  const ownerFavorites = await listFavorites(owner);
  assert.deepEqual(ownerFavorites, ['chat']);
});

test('onFavoritesChange(): a single call delivers the CURRENT favorite immediately, not just future changes', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  await addFavorite(owner, 'chat');
  await wait();

  const seen = [];
  onFavoritesChange(owner, (q) => seen.push(q.value?.appId));
  await wait();

  assert.ok(seen.includes('chat'), 'the already-favorited app must arrive without a separate one-shot listFavorites() call');
});

test('qu.addFavorite()/qu.removeFavorite()/etc.: the qu-bound convenience wrappers behave identically to the standalone functions', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin()).use(createFavoritesPlugin());

  await owner.addFavorite('chat');
  assert.deepEqual(await owner.listFavorites(), ['chat']);

  await owner.removeFavorite('chat');
  assert.equal((await owner.listFavorites()).length, 0);
});
