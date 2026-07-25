import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import { createBoard, createTopic, listPosts, onPosts, listBuckets, olderBucket, addReply, listReplies, onReplies } from './forum-lib.mjs';

test('topics land in the current bucket by default; listPosts() never sees a different bucket', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  await createTopic(owner, boardId, { title: 'Hello', text: 'hello board' }, { bucket: '2026-07' });
  await createTopic(owner, boardId, { title: 'Also', text: 'also this month' }, { bucket: '2026-07' });
  await createTopic(owner, boardId, { title: 'Old', text: 'a much older post' }, { bucket: '2025-01' });

  const julyPosts = await listPosts(owner, boardId, '2026-07');
  assert.equal(julyPosts.length, 2, 'only the requested bucket, never the whole board');
  assert.deepEqual(julyPosts.map((p) => p.value.title).sort(), ['Also', 'Hello']);
  assert.deepEqual(julyPosts.map((p) => p.value.text).sort(), ['also this month', 'hello board']);

  const januaryPosts = await listPosts(owner, boardId, '2025-01');
  assert.equal(januaryPosts.length, 1);
});

test('onPosts() live-subscribes to one bucket only — a topic in a different bucket is never delivered', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  const seen = [];
  onPosts(owner, boardId, (q) => seen.push(q.value.text), { bucket: '2026-07' });

  await createTopic(owner, boardId, { title: 'This', text: 'this month' }, { bucket: '2026-07' });
  await createTopic(owner, boardId, { title: 'Last', text: 'last month' }, { bucket: '2026-06' });
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(seen, ['this month'], 'the live subscription must never leak a different bucket');
});

test('listBuckets()/olderBucket(): the bucket index lets a client discover and load history without a pagination primitive', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  await createTopic(owner, boardId, { title: 'Oldest', text: 'oldest' }, { bucket: '2026-05' });
  await createTopic(owner, boardId, { title: 'Middle', text: 'middle' }, { bucket: '2026-06' });
  await createTopic(owner, boardId, { title: 'Newest', text: 'newest' }, { bucket: '2026-07' });
  // A second topic in an already-known bucket must not create a duplicate index entry.
  await createTopic(owner, boardId, { title: 'Newest again', text: 'newest again' }, { bucket: '2026-07' });

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
    createTopic(alice, boardId, { title: 'Alice', text: 'from alice' }, { bucket: '2026-07' }),
    createTopic(bob, boardId, { title: 'Bob', text: 'from bob' }, { bucket: '2026-07' }),
  ]);

  const posts = await listPosts(owner, boardId, '2026-07');
  assert.equal(posts.length, 2, 'neither post was silently overwritten by the other');
  assert.deepEqual(posts.map((p) => p.writer).sort(), [alice.fingerprint, bob.fingerprint].sort());
});

test('addReply()/listReplies(): replies attach to a topic regardless of which bucket it lives in', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner, { writers: ['*'] });
  const alice = await Qu.create({ runtime: owner.runtime });

  const topic = await createTopic(owner, boardId, { title: 'Question', text: 'anyone know...?' }, { bucket: '2025-01' });

  await addReply(owner, topic.qubit.id, 'own follow-up');
  await addReply(alice, topic.qubit.id, 'here is the answer');

  const replies = await listReplies(owner, topic.qubit.id);
  assert.equal(replies.length, 2);
  assert.deepEqual(replies.map((r) => r.value.text), ['own follow-up', 'here is the answer'], 'oldest first');
  assert.deepEqual(replies.map((r) => r.writer).sort(), [owner.fingerprint, alice.fingerprint].sort());
});

test('onReplies(): live-subscribes to exactly one topic\'s replies, not the whole board', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const boardId = await createBoard(owner);

  const topicA = await createTopic(owner, boardId, { title: 'A', text: 'topic a' }, { bucket: '2026-07' });
  const topicB = await createTopic(owner, boardId, { title: 'B', text: 'topic b' }, { bucket: '2026-07' });

  const seen = [];
  onReplies(owner, topicA.qubit.id, (q) => seen.push(q.value.text));

  await addReply(owner, topicA.qubit.id, 'reply to a');
  await addReply(owner, topicB.qubit.id, 'reply to b');
  await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(seen, ['reply to a'], 'a reply to a different topic must never be delivered here');
});
