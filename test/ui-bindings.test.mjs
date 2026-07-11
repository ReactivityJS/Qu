import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, viewKey, viewObject, bindKey, bindObject } from '../src/index.js';

function wait(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

/** A DOM-free stand-in for <input>/<textarea> — just enough shape for bindKey's default get/set/event contract. */
function mockInput(initial = '') {
  const listeners = new Map();
  return {
    value: initial,
    addEventListener(event, fn) { listeners.set(event, fn); },
    removeEventListener(event, fn) { if (listeners.get(event) === fn) listeners.delete(event); },
    async fire(event = 'input') { await listeners.get(event)?.(); },
  };
}

test('viewKey: delivers an existing value on mount (initial:true), then every future change', async () => {
  const qu = await Qu.create();
  const id = `${qu.userSpaceId}/note`;
  await qu.publish(id, 'first');

  const seen = [];
  const off = viewKey(qu, id, (value) => seen.push(value));
  await wait();
  assert.deepEqual(seen, ['first']);

  await qu.publish(id, 'second');
  await wait();
  assert.deepEqual(seen, ['first', 'second']);
  off();
});

test('viewObject: renders existing children on mount, and new children live, one item per key', async () => {
  const qu = await Qu.create();
  const prefix = `${qu.userSpaceId}/rows`;
  await qu.publish(`${prefix}/a`, { label: 'A' });
  await qu.publish(`${prefix}/b`, { label: 'B' });

  const created = [];
  const rendered = [];
  const off = viewObject(qu, prefix, {
    createItem: (q) => { created.push(q.id); return { id: q.id }; },
    render: (item, value) => rendered.push(`${item.id}:${value.label}`),
  });
  await wait();
  assert.deepEqual(created.sort(), [`${prefix}/a`, `${prefix}/b`]);
  assert.deepEqual(rendered.sort(), [`${prefix}/a:A`, `${prefix}/b:B`]);

  await qu.publish(`${prefix}/c`, { label: 'C' });
  await wait();
  assert.equal(created.length, 3, 'a new child gets its own createItem() call');
  assert.ok(rendered.includes(`${prefix}/c:C`));

  // Republishing an existing key must render again but not re-create the item.
  await qu.publish(`${prefix}/a`, { label: 'A2' });
  await wait();
  assert.equal(created.length, 3, 'an update to an existing key must not call createItem() again');
  assert.ok(rendered.includes(`${prefix}/a:A2`));

  off();
});

test('bindKey: a local edit publishes, and an identical value never triggers a write', async () => {
  const qu = await Qu.create();
  const id = `${qu.userSpaceId}/name`;
  const input = mockInput('');

  const off = bindKey(qu, id, input);
  await wait();

  input.value = 'Alice';
  await input.fire();
  await wait();
  assert.equal((await qu.get(id)).value, 'Alice', 'the edit must have been published');
  const afterFirstEdit = await qu.get(id);

  // Same value again — must be a no-op, not a second write with a new ts.
  input.value = 'Alice';
  await input.fire();
  await wait();
  const afterSecondEdit = await qu.get(id);
  assert.equal(afterSecondEdit.ts, afterFirstEdit.ts, 'an identical value must never be republished');

  off();
});

test('bindKey: its own write does not bounce back and stomp the element (no redundant set())', async () => {
  const qu = await Qu.create();
  const id = `${qu.userSpaceId}/title`;
  const input = mockInput('');
  let setCalls = 0;
  const set = (el, v) => { setCalls++; el.value = v; };

  const off = bindKey(qu, id, input, { set });
  await wait();
  assert.equal(setCalls, 0, 'nothing existed yet, so the initial subscription has nothing to render');

  input.value = 'typed locally';
  await input.fire();
  await wait();
  assert.equal(setCalls, 0, 'the echo of our own write must be recognized and skipped — set() must not run again for a value the element already has');
  assert.equal((await qu.get(id)).value, 'typed locally');

  off();
});

test('bindKey: a second, independent binding to the same id still sees the first one\'s write', async () => {
  const qu = await Qu.create();
  const id = `${qu.userSpaceId}/shared-field`;
  const inputA = mockInput('');
  const inputB = mockInput('');

  const offA = bindKey(qu, id, inputA);
  const offB = bindKey(qu, id, inputB);
  await wait();

  inputA.value = 'from A';
  await inputA.fire();
  await wait();

  assert.equal(inputA.value, 'from A', 'A shows its own edit');
  assert.equal(inputB.value, 'from A', 'B is a different binding — it must still receive the update normally, not be caught by A\'s echo guard');

  offA();
  offB();
});

test('bindKey: a rejected write reverts the element to its previous value and calls onError', async () => {
  const qu = await Qu.create();
  const id = 'not-my-user-space/forbidden'; // outside the caller's own User-Space -> core identity-acl.js denies it
  const input = mockInput('');
  const errors = [];

  const off = bindKey(qu, id, input, { onError: (e) => errors.push(e) });
  input.value = 'should not stick';
  await input.fire();
  await wait();

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /\[ACL\] Write denied/);
  assert.equal(input.value, '', 'reverted to the previous (empty) value after the rejected write');

  off();
});

test('bindObject: each field is its own leaf QuBit, editable independently', async () => {
  const qu = await Qu.create();
  const prefix = `${qu.userSpaceId}/profile`;
  const nameInput = mockInput('');
  const bioInput = mockInput('');

  const off = bindObject(qu, prefix, { name: nameInput, bio: bioInput });
  await wait();

  nameInput.value = 'Alice';
  await nameInput.fire();
  bioInput.value = 'Likes QuBits';
  await bioInput.fire();
  await wait();

  assert.equal((await qu.get(`${prefix}/name`)).value, 'Alice');
  assert.equal((await qu.get(`${prefix}/bio`)).value, 'Likes QuBits');
  assert.equal(bioInput.value, 'Likes QuBits', 'editing one field must not disturb the other');

  off();
});
