import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin } from '../src/index.js';
import {
  getManifest, canWrite, isAdmin, listWriters, grantWriteAccess, revokeWriteAccess,
  parseHashRoute, buildHashRoute,
} from './space-app-lib.mjs';

test('getManifest()/canWrite()/isAdmin(): owner can write and is admin; a stranger is neither', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const stranger = await Qu.create({ runtime: owner.runtime });
  const space = owner.createSpace({ writers: [owner.fingerprint], readers: ['*'] });
  await space.ready;

  const manifest = await getManifest(owner, space.id);
  assert.deepEqual(manifest.writers, [owner.fingerprint]);

  assert.equal(await canWrite(owner, space.id), true);
  assert.equal(await isAdmin(owner, space.id), true);
  assert.equal(await canWrite(stranger, space.id), false);
  assert.equal(await isAdmin(stranger, space.id), false);

  assert.equal(await getManifest(owner, 'never-created'), null);
  assert.equal(await canWrite(owner, 'never-created'), false);
});

test('grantWriteAccess()/revokeWriteAccess()/listWriters(): the full add/remove cycle, symmetric', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const alice = await Qu.create({ runtime: owner.runtime });
  const space = owner.createSpace({ writers: [owner.fingerprint], readers: ['*'] });
  await space.ready;

  assert.equal(await canWrite(alice, space.id), false);
  await grantWriteAccess(owner, space.id, alice.fingerprint);
  assert.equal(await canWrite(alice, space.id), true);
  assert.deepEqual((await listWriters(owner, space.id)).sort(), [alice.fingerprint, owner.fingerprint].sort());

  await revokeWriteAccess(owner, space.id, alice.fingerprint);
  assert.equal(await canWrite(alice, space.id), false);
  assert.deepEqual(await listWriters(owner, space.id), [owner.fingerprint]);

  // The owner themself must still be able to write after someone else's access was revoked.
  assert.equal(await canWrite(owner, space.id), true);
});

test('a non-admin writer cannot grant or revoke access — only an admin can change the manifest', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const alice = await Qu.create({ runtime: owner.runtime });
  const bob = await Qu.create({ runtime: owner.runtime });
  const space = owner.createSpace({ writers: [owner.fingerprint], readers: ['*'] });
  await space.ready;

  await grantWriteAccess(owner, space.id, alice.fingerprint); // alice can write items, but is not admin
  await assert.rejects(() => grantWriteAccess(alice, space.id, bob.fingerprint));
  await assert.rejects(() => revokeWriteAccess(alice, space.id, owner.fingerprint));
});

test('listWriters() hides the "*" open-write marker — it is not a real fingerprint to manage', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const space = owner.createSpace({ writers: ['*'], readers: ['*'] });
  await space.ready;
  assert.deepEqual(await listWriters(owner, space.id), []);
});

test('parseHashRoute()/buildHashRoute(): a pure round trip, spaceId-only and spaceId+path', () => {
  assert.deepEqual(parseHashRoute('#abc-123/blog/hello-world'), { spaceId: 'abc-123', path: 'blog/hello-world' });
  assert.deepEqual(parseHashRoute('#abc-123'), { spaceId: 'abc-123', path: '' });
  assert.deepEqual(parseHashRoute('abc-123/x'), { spaceId: 'abc-123', path: 'x' }, 'a leading "#" is optional to parse');
  assert.deepEqual(parseHashRoute(''), { spaceId: null, path: '' });
  assert.deepEqual(parseHashRoute('#'), { spaceId: null, path: '' });

  assert.equal(buildHashRoute('abc-123', 'blog/hello-world'), '#abc-123/blog/hello-world');
  assert.equal(buildHashRoute('abc-123'), '#abc-123');
  assert.equal(buildHashRoute('abc-123', ''), '#abc-123');

  const spaceId = 'x9';
  const path = 'a/b/c';
  assert.deepEqual(parseHashRoute(buildHashRoute(spaceId, path)), { spaceId, path });
});
