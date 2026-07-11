import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Qu, isReference, parseReference, objRef, keyRef, fileRef,
  resolveReference, resolveValue, createReferenceHandlerPlugin,
} from '../src/index.js';

// Every path below lives under the calling Qu's own User-Space
// (`qu.userSpaceId`) — References are orthogonal to Spaces/ACL, and this
// keeps these tests from needing the Spaces plugin at all (see
// core/identity-acl.js: the Core default only ever grants writes under
// your own User-Space).

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
  const base = qu.userSpaceId;
  await qu.publish(`${base}/users/alice`, { name: 'Alice' });
  await qu.publish(`${base}/posts/1`, { title: 'hello', author: keyRef(`${base}/users/alice`) });

  const post = await qu.get(`${base}/posts/1`);
  const resolved = await resolveValue(qu, post.value);
  assert.deepEqual(resolved.author, { name: 'Alice' });
});

test('key:// to a missing path resolves to undefined, not an error', async () => {
  const qu = await Qu.create();
  const resolved = await resolveReference(qu, keyRef(`${qu.userSpaceId}/nope/nothing-here`));
  assert.equal(resolved, undefined);
});

test('obj:// collects direct children into an object keyed by their last path segment', async () => {
  const qu = await Qu.create();
  const base = qu.userSpaceId;
  await qu.publish(`${base}/table/row-a`, { name: 'Apple' });
  await qu.publish(`${base}/table/row-b`, { name: 'Banana' });
  await qu.publish(`${base}/table/row-a/not-a-direct-child`, { ignored: true }); // deeper than one segment — must not appear

  const rows = await resolveReference(qu, objRef(`${base}/table`));
  assert.deepEqual(rows, {
    'row-a': { name: 'Apple' },
    'row-b': { name: 'Banana' },
  });
});

test('obj:// with asArray sorts by segment into a plain array — this is how lists/tables are built', async () => {
  const qu = await Qu.create();
  const base = qu.userSpaceId;
  await qu.publish(`${base}/list/0002`, { text: 'second' });
  await qu.publish(`${base}/list/0001`, { text: 'first' });
  await qu.publish(`${base}/list/0003`, { text: 'third' });

  const items = await resolveReference(qu, objRef(`${base}/list`), { asArray: true });
  assert.deepEqual(items.map((i) => i.text), ['first', 'second', 'third']);
});

test('maxDepth bounds how far cascading refs are followed — beyond budget, a ref is left as the raw string', async () => {
  const qu = await Qu.create();
  const base = qu.userSpaceId;
  await qu.publish(`${base}/a`, { next: keyRef(`${base}/b`) });
  await qu.publish(`${base}/b`, { next: keyRef(`${base}/c`) });
  await qu.publish(`${base}/c`, { value: 'leaf' });

  const shallow = await resolveReference(qu, keyRef(`${base}/a`), { maxDepth: 1 });
  assert.equal(shallow.next, `key://${base}/b`, 'depth budget exhausted after resolving "a" itself — "b" must stay unresolved');

  const deeper = await resolveReference(qu, keyRef(`${base}/a`), { maxDepth: 2 });
  assert.deepEqual(deeper.next, { next: `key://${base}/c` }, 'one more cascade: "b" resolves, but "c" inside it does not');

  const full = await resolveReference(qu, keyRef(`${base}/a`), { maxDepth: 3 });
  assert.deepEqual(full.next.next, { value: 'leaf' });
});

test('a reference cycle resolves to the raw ref string instead of hanging', async () => {
  const qu = await Qu.create();
  const base = qu.userSpaceId;
  await qu.publish(`${base}/x`, { next: keyRef(`${base}/y`) });
  await qu.publish(`${base}/y`, { next: keyRef(`${base}/x`) }); // points back at x

  const resolved = await resolveReference(qu, keyRef(`${base}/x`), { maxDepth: 10 });
  assert.deepEqual(resolved, { next: { next: `key://${base}/x` } }, 'the second time "x" is reached it is already in the seen-set, so it is left unresolved');
});

test('resolveValue() walks arrays and nested objects, resolving every ref found inside', async () => {
  const qu = await Qu.create();
  const base = qu.userSpaceId;
  await qu.publish(`${base}/items/1`, { label: 'one' });
  await qu.publish(`${base}/items/2`, { label: 'two' });

  const value = { title: 'my list', entries: [keyRef(`${base}/items/1`), keyRef(`${base}/items/2`)], meta: { first: keyRef(`${base}/items/1`) } };
  const resolved = await resolveValue(qu, value);
  assert.deepEqual(resolved.entries, [{ label: 'one' }, { label: 'two' }]);
  assert.deepEqual(resolved.meta.first, { label: 'one' });
  assert.equal(resolved.title, 'my list', 'non-reference values pass through unchanged');
});

test('file:// delegates to the supplied fileHandler instead of returning the raw manifest', async () => {
  const qu = await Qu.create();
  const manifestId = `${qu.userSpaceId}/manifests/f1`;
  await qu.publish(manifestId, { name: 'f.txt', chunks: ['deadbeef'] });
  const fakeFileHandler = { resolveFileRef: async (_qu, ref) => `bytes-for:${ref}` };

  const resolved = await resolveReference(qu, fileRef(manifestId), { fileHandler: fakeFileHandler });
  assert.equal(resolved, `bytes-for:${fileRef(manifestId)}`);
});

test('file:// without a fileHandler falls back to the raw manifest QuBit\'s value', async () => {
  const qu = await Qu.create();
  const manifestId = `${qu.userSpaceId}/manifests/f1`;
  await qu.publish(manifestId, { name: 'f.txt', chunks: ['deadbeef'] });
  const resolved = await resolveReference(qu, fileRef(manifestId));
  assert.deepEqual(resolved, { name: 'f.txt', chunks: ['deadbeef'] });
});

test('createReferenceHandlerPlugin(): qu.use() attaches resolveReference()/resolveValue() sugar with the given defaults', async () => {
  const qu = await Qu.create();
  const base = qu.userSpaceId;
  await qu.publish(`${base}/table/a`, { n: 1 });
  await qu.publish(`${base}/table/b`, { n: 2 });
  assert.equal(typeof qu.resolveReference, 'undefined', 'must not exist before use()');

  qu.use(createReferenceHandlerPlugin({ maxDepth: 1, asArray: true }));
  assert.equal(typeof qu.resolveReference, 'function');
  assert.equal(typeof qu.resolveValue, 'function');

  const rows = await qu.resolveReference(objRef(`${base}/table`));
  assert.deepEqual(rows.map((r) => r.n).sort(), [1, 2], 'plugin default asArray:true applies without passing it per call');
});
