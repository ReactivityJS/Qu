import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import { createBoard, addPost, listPosts, onPosts, listBuckets, olderBucket } from './forum-lib.mjs';

test('posts land in the current bucket by default; listPosts() never sees a different bucket', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  await addPost(owner, boardId, 'hello board', { bucket: '2026-07' });
  await addPost(owner, boardId, 'also this month', { bucket: '2026-07' });
  await addPost(owner, boardId, 'a much older post', { bucket: '2025-01' });

  const julyPosts = await listPosts(owner, boardId, '2026-07');
  assert.equal(julyPosts.length, 2, 'only the requested bucket, never the whole board');
  assert.deepEqual(julyPosts.map((p) => p.value.text).sort(), ['also this month', 'hello board']);

  const januaryPosts = await listPosts(owner, boardId, '2025-01');
  assert.equal(januaryPosts.length, 1);
});

test('onPosts() live-subscribes to one bucket only — a post in a different bucket is never delivered', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  const seen = [];
  onPosts(owner, boardId, (q) => seen.push(q.value.text), { bucket: '2026-07' });

  await addPost(owner, boardId, 'this month', { bucket: '2026-07' });
  await addPost(owner, boardId, 'last month', { bucket: '2026-06' });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(seen, ['this month'], 'the live subscription must never leak a different bucket');
});

test('listBuckets()/olderBucket(): the bucket index lets a client discover and load history without a pagination primitive', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  await addPost(owner, boardId, 'oldest', { bucket: '2026-05' });
  await addPost(owner, boardId, 'middle', { bucket: '2026-06' });
  await addPost(owner, boardId, 'newest', { bucket: '2026-07' });
  // A second post in an already-known bucket must not create a duplicate index entry.
  await addPost(owner, boardId, 'newest again', { bucket: '2026-07' });

  const buckets = await listBuckets(owner, boardId);
  assert.deepEqual(buckets, ['2026-05', '2026-06', '2026-07'], 'chronologically sorted, deduplicated');

  assert.equal(await olderBucket(owner, boardId, '2026-07'), '2026-06');
  assert.equal(await olderBucket(owner, boardId, '2026-06'), '2026-05');
  assert.equal(await olderBucket(owner, boardId, '2026-05'), null, 'no bucket before the oldest one');
});

test('multiple independent writers posting into the same bucket at once never collide', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner, { writers: ['*'] });
  const alice = await Qu.create({ runtime: owner.runtime });
  const bob = await Qu.create({ runtime: owner.runtime });

  await Promise.all([
    addPost(alice, boardId, 'from alice', { bucket: '2026-07' }),
    addPost(bob, boardId, 'from bob', { bucket: '2026-07' }),
  ]);

  const posts = await listPosts(owner, boardId, '2026-07');
  assert.equal(posts.length, 2, 'neither post was silently overwritten by the other');
  assert.deepEqual(posts.map((p) => p.writer).sort(), [alice.fingerprint, bob.fingerprint].sort());
});
