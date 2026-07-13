import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, createReferenceHandlerPlugin, keyRef, objRef } from '../src/index.js';

function wait(ms = 30) { return new Promise((r) => setTimeout(r, ms)); }

test('without createReferenceHandlerPlugin(), a key:// value is returned as-is — resolveDispatch defaults to identity, Core stays unaware references exist', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;
  await alice.own.get('link').put(keyRef(target.id));

  const q = await alice.own.get('link');
  assert.equal(q.value, keyRef(target.id), 'no resolution happens without the plugin installed');
});

test('await node transparently follows a single key:// hop — the returned qubit\'s .id reflects the real target, not the alias path', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;
  await target.get('info').put({ hello: 'target' });

  const alias = alice.own.get('link');
  await alias.put(keyRef(target.get('info').id));

  const resolved = await alias;
  assert.deepEqual(resolved.value, { hello: 'target' });
  assert.equal(resolved.id, target.get('info').id, 'the resolved id is the REAL target, not the alias — enables qu.get(resolved.id) to keep navigating');
});

test('chained key:// (alias -> alias -> real value) resolves all the way through', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;
  await target.get('info').put({ hello: 'deep target' });

  const middle = alice.own.get('middle');
  await middle.put(keyRef(target.get('info').id));
  const outer = alice.own.get('outer');
  await outer.put(keyRef(middle.id));

  const resolved = await outer;
  assert.deepEqual(resolved.value, { hello: 'deep target' });
  assert.equal(resolved.id, target.get('info').id);
});

test('a key:// cycle (A -> B -> A) throws a clear error instead of hanging', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const a = alice.own.get('cycleA');
  const b = alice.own.get('cycleB');
  await a.put(keyRef(b.id));
  await b.put(keyRef(a.id));

  await assert.rejects(async () => { await a; }, /Zyklus/);
});

test('a long, non-cyclic chain exceeding maxHops throws a clear budget error, not a cycle false-positive', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin({ maxHops: 3 }));
  const leaf = alice.own.get('leaf');
  await leaf.put('the value');
  const hop2 = alice.own.get('hop2');
  await hop2.put(keyRef(leaf.id));
  const hop1 = alice.own.get('hop1');
  await hop1.put(keyRef(hop2.id));
  const hop0 = alice.own.get('hop0');
  await hop0.put(keyRef(hop1.id)); // hop0 -> hop1 -> hop2 -> leaf = 3 hops, exactly at budget

  const ok = await hop0;
  assert.equal(ok.value, 'the value', 'exactly maxHops chained redirects still resolves');

  const tooDeep = alice.own.get('tooDeep');
  await tooDeep.put(keyRef(hop0.id)); // one hop too many
  await assert.rejects(async () => { await tooDeep; }, /zu viele verkettete/);
});

test('put()/set() redirect through a key:// found AT the id they are called on directly — ACL applies to the REAL target, not the alias owner', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const mallory = await Qu.create({ runtime: alice.runtime });
  mallory.use(createSpacesPlugin()).use(createReferenceHandlerPlugin());

  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;

  // alice herself can write through her own alias, landing at the real target:
  const aliceAlias = alice.own.get('boardSettings');
  await aliceAlias.put(keyRef(target.get('settings').id));
  await aliceAlias.put({ theme: 'dark' });
  assert.deepEqual((await target.get('settings')).value, { theme: 'dark' });

  // mallory can create her OWN alias pointing at the same (alice-owned, restricted) target —
  // aliases are just plain data under mallory's own writable space — but writing THROUGH it
  // is denied, because ACL follows the target space, not the alias owner:
  const malloryAlias = mallory.own.get('linkToAliceBoard');
  await malloryAlias.put(keyRef(target.get('settings').id));
  await assert.rejects(() => malloryAlias.put({ theme: 'hacked' }), /\[ACL\] Write denied/);
});

test('set() through an alias appends under the REAL resolved collection, not the literal alias path', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;

  const alias = alice.own.get('currentBoardPosts');
  await alias.put(keyRef(`${target.id}/posts`));
  await alias.set({ text: 'via alias' });

  const rows = await target.session.query(`${target.id}/posts/**`);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].value, { text: 'via alias' });
});

test('NO mid-path resolution: node.get(subpath) stays a literal string build, even when the parent is a key:// alias — resolution only happens at the id the verb is actually called on', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;

  const alias = alice.own.get('boardLink');
  await alias.put(keyRef(target.id));

  // alias.get('posts') builds an EXTENDED, non-aliased literal path FIRST (pure sync, no I/O) —
  // .set() then resolves THAT (unreferenced) id, which is just itself:
  await alias.get('posts').set({ text: 'lands under the alias owner\'s own space' });
  const underAliasPath = await alice.session.query(`${alice.userSpaceId}/boardLink/posts/**`);
  const underRealTarget = await target.session.query(`${target.id}/posts/**`);
  assert.equal(underAliasPath.length, 1, 'unresolved mid-path write lands literally where .get() built it');
  assert.equal(underRealTarget.length, 0, 'NOT redirected into the real target — no accidental cross-space writes from chained .get()');
});

test('{ raw: true } opts out of resolution on put/set/on/map; node.session.get(node.id) is the equivalent for await', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;

  const alias = alice.own.get('rawTest');
  await alias.put(keyRef(target.id));

  // await escape hatch:
  const raw = await alice.session.get(alias.id);
  assert.equal(raw.value, keyRef(target.id));

  // put({raw:true}) writes the literal alias id, not the resolved target:
  await alias.put({ overwritten: true }, { raw: true });
  const rawAfter = await alice.session.get(alias.id);
  assert.deepEqual(rawAfter.value, { overwritten: true }, 'raw:true put() overwrote the alias itself, did not redirect');
});

test('map() resolves once at activation (not per event) and live-subscribes to the resolved target\'s children', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  const target = alice.createSpace({ writers: [alice.fingerprint], readers: ['*'] });
  await target.ready;

  const alias = alice.own.get('boardPostsLink');
  await alias.put(keyRef(`${target.id}/posts`));

  const seen = [];
  const off = alias.map((q) => seen.push(q.value.text));
  await wait();
  await target.get('posts').set({ text: 'first' });
  await wait();
  await target.get('posts').set({ text: 'second' });
  await wait();
  assert.deepEqual(seen.sort(), ['first', 'second'], 'live delivery works through a ONE-TIME resolved subscription');
  off();
});

test('on()/map() { raw: true } keeps the old, purely synchronous, zero-setup-gap behavior against the literal id', async () => {
  const alice = await Qu.create();
  const events = [];
  const off = alice.own.get('plain').on((q) => events.push(q.value), { raw: true, initial: false });
  await alice.own.get('plain').put('hello'); // no gap: subscribed synchronously before this line even runs
  await wait(10);
  assert.deepEqual(events, ['hello']);
  off();
});

test('a value that is NOT a reference passes through resolve unaffected — no behavior change for ordinary reads/writes', async () => {
  const alice = (await Qu.create()).use(createReferenceHandlerPlugin());
  await alice.own.get('plain').put({ ordinary: 'value' });
  const q = await alice.own.get('plain');
  assert.deepEqual(q.value, { ordinary: 'value' });
});

test('obj:// and file:// are NOT auto-followed by the resolver — only key:// is; resolveKeyChain() stops at them, resolveReference()/resolveFileRef() remain the explicit way to read those', async () => {
  const alice = (await Qu.create()).use(createSpacesPlugin()).use(createReferenceHandlerPlugin());
  await alice.own.get('row1').put({ n: 1 });
  await alice.own.get('row2').put({ n: 2 });

  const alias = alice.own.get('listLink');
  await alias.put(objRef(`${alice.userSpaceId}`));

  const q = await alias; // resolveKeyChain sees obj:// and stops — returns it unresolved, as documented
  assert.equal(q.value, objRef(`${alice.userSpaceId}`), 'obj:// is left as-is by the default resolver, not auto-collected into an object');
});
