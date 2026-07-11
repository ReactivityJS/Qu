import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, isReference, parseReference, objRef, keyRef, fileRef,
  resolveReference, resolveValue, createReferenceHandlerPlugin,
} from '../src/index.js';

test('isReference()/parseReference() recognize obj://, key://, file:// and reject everything else', () => {
  assert.equal(isReference('obj://a/b'), true);
  assert.equal(isReference('key://a/b'), true);
  assert.equal(isReference('file://abc123'), true);
  assert.equal(isReference('http://not-a-qu-ref'), false);
  assert.equal(isReference(42), false);
  assert.deepEqual(parseReference('key://room/msg1'), { scheme: 'key', path: 'room/msg1' });
  assert.equal(objRef('a/b'), 'obj://a/b');
  assert.equal(keyRef('a/b'), 'key://a/b');
  assert.equal(fileRef('abc123'), 'file://abc123');
});

test('key:// resolves to the pointed-at QuBit\'s value', async () => {
  const qu = await Qu.create();
  await qu.publish('users/alice', { name: 'Alice' });
  await qu.publish('posts/1', { title: 'hello', author: keyRef('users/alice') });

  const post = await qu.get('posts/1');
  const resolved = await resolveValue(qu, post.value);
  assert.deepEqual(resolved.author, { name: 'Alice' });
});

test('key:// to a missing path resolves to undefined, not an error', async () => {
  const qu = await Qu.create();
  const resolved = await resolveReference(qu, keyRef('nope/nothing-here'));
  assert.equal(resolved, undefined);
});

test('obj:// collects direct children into an object keyed by their last path segment', async () => {
  const qu = await Qu.create();
  await qu.publish('table/row-a', { name: 'Apple' });
  await qu.publish('table/row-b', { name: 'Banana' });
  await qu.publish('table/row-a/not-a-direct-child', { ignored: true }); // deeper than one segment — must not appear

  const rows = await resolveReference(qu, objRef('table'));
  assert.deepEqual(rows, {
    'row-a': { name: 'Apple' },
    'row-b': { name: 'Banana' },
  });
});

test('obj:// with asArray sorts by segment into a plain array — this is how lists/tables are built', async () => {
  const qu = await Qu.create();
  await qu.publish('list/0002', { text: 'second' });
  await qu.publish('list/0001', { text: 'first' });
  await qu.publish('list/0003', { text: 'third' });

  const items = await resolveReference(qu, objRef('list'), { asArray: true });
  assert.deepEqual(items.map((i) => i.text), ['first', 'second', 'third']);
});

test('maxDepth bounds how far cascading refs are followed — beyond budget, a ref is left as the raw string', async () => {
  const qu = await Qu.create();
  await qu.publish('a', { next: keyRef('b') });
  await qu.publish('b', { next: keyRef('c') });
  await qu.publish('c', { value: 'leaf' });

  const shallow = await resolveReference(qu, keyRef('a'), { maxDepth: 1 });
  assert.equal(shallow.next, 'key://b', 'depth budget exhausted after resolving "a" itself — "b" must stay unresolved');

  const deeper = await resolveReference(qu, keyRef('a'), { maxDepth: 2 });
  assert.deepEqual(deeper.next, { next: 'key://c' }, 'one more cascade: "b" resolves, but "c" inside it does not');

  const full = await resolveReference(qu, keyRef('a'), { maxDepth: 3 });
  assert.deepEqual(full.next.next, { value: 'leaf' });
});

test('a reference cycle resolves to the raw ref string instead of hanging', async () => {
  const qu = await Qu.create();
  await qu.publish('x', { next: keyRef('y') });
  await qu.publish('y', { next: keyRef('x') }); // points back at x

  const resolved = await resolveReference(qu, keyRef('x'), { maxDepth: 10 });
  assert.deepEqual(resolved, { next: { next: 'key://x' } }, 'the second time "x" is reached it is already in the seen-set, so it is left unresolved');
});

test('resolveValue() walks arrays and nested objects, resolving every ref found inside', async () => {
  const qu = await Qu.create();
  await qu.publish('items/1', { label: 'one' });
  await qu.publish('items/2', { label: 'two' });

  const value = { title: 'my list', entries: [keyRef('items/1'), keyRef('items/2')], meta: { first: keyRef('items/1') } };
  const resolved = await resolveValue(qu, value);
  assert.deepEqual(resolved.entries, [{ label: 'one' }, { label: 'two' }]);
  assert.deepEqual(resolved.meta.first, { label: 'one' });
  assert.equal(resolved.title, 'my list', 'non-reference values pass through unchanged');
});

test('file:// delegates to the supplied fileHandler instead of returning the raw manifest', async () => {
  const qu = await Qu.create();
  await qu.publish('manifests/f1', { name: 'f.txt', chunks: ['deadbeef'] });
  const fakeFileHandler = { resolveFileRef: async (_qu, ref) => `bytes-for:${ref}` };

  const resolved = await resolveReference(qu, fileRef('manifests/f1'), { fileHandler: fakeFileHandler });
  assert.equal(resolved, 'bytes-for:file://manifests/f1');
});

test('file:// without a fileHandler falls back to the raw manifest QuBit\'s value', async () => {
  const qu = await Qu.create();
  await qu.publish('manifests/f1', { name: 'f.txt', chunks: ['deadbeef'] });
  const resolved = await resolveReference(qu, fileRef('manifests/f1'));
  assert.deepEqual(resolved, { name: 'f.txt', chunks: ['deadbeef'] });
});

test('createReferenceHandlerPlugin(): qu.use() attaches resolveReference()/resolveValue() sugar with the given defaults', async () => {
  const qu = await Qu.create();
  await qu.publish('table/a', { n: 1 });
  await qu.publish('table/b', { n: 2 });
  assert.equal(typeof qu.resolveReference, 'undefined', 'must not exist before use()');

  qu.use(createReferenceHandlerPlugin({ maxDepth: 1, asArray: true }));
  assert.equal(typeof qu.resolveReference, 'function');
  assert.equal(typeof qu.resolveValue, 'function');

  const rows = await qu.resolveReference(objRef('table'));
  assert.deepEqual(rows.map((r) => r.n).sort(), [1, 2], 'plugin default asArray:true applies without passing it per call');
});
