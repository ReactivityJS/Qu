import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Qu, createSpacesPlugin, userSpaceId } from '../src/index.js';
import { decryptWith } from '../src/core/crypto.js';

test('publishProfile()/readProfile(): pub/epub are discoverable via ~fp/..., alias falls back to the fingerprint', async () => {
  const alice = await Qu.create();
  await alice.publishProfile({ alias: 'Alice' });

  const bob = await Qu.create({ runtime: alice.runtime });
  const seenByBob = await bob.readProfile(alice.fingerprint);
  assert.equal(seenByBob.alias, 'Alice');
  assert.equal(seenByBob.fingerprint, alice.fingerprint);
  assert.ok(seenByBob.pub, 'signing public key must be readable');
  assert.ok(seenByBob.epub, 'ECDH public key must be readable');

  const noAlias = await Qu.create({ runtime: alice.runtime });
  await noAlias.publishProfile(); // no alias given
  const seenNoAlias = await bob.readProfile(noAlias.fingerprint);
  assert.equal(seenNoAlias.alias, noAlias.fingerprint, 'alias falls back to the fingerprint when never published');
});

test('a restricted-readers Space auto-encrypts for exactly those readers — 1 sender + 3 recipients, no explicit encryptFor/trustPeer needed', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const r1 = await Qu.create({ runtime: owner.runtime });
  const r2 = await Qu.create({ runtime: owner.runtime });
  const r3 = await Qu.create({ runtime: owner.runtime });
  const outsider = await Qu.create({ runtime: owner.runtime });

  // Every member publishes their profile first — this is how the sender
  // discovers each recipient's ECDH key without a manual trustPeer() call.
  await Promise.all([owner, r1, r2, r3].map((qu) => qu.publishProfile()));

  const readers = [owner.fingerprint, r1.fingerprint, r2.fingerprint, r3.fingerprint];
  const room = owner.createSpace({ writers: readers, readers });
  await room.ready;

  const written = await room.get('msgs').set({ text: 'group secret' }); // no encryptFor — must default
  const msgId = written.qubit.id;

  for (const member of [owner, r1, r2, r3]) {
    const view = await member.get(msgId);
    assert.equal(view.value.text, 'group secret', `${member.fingerprint} must be able to read the group message`);
  }

  // ACL already hides it from a non-reader's query/get — but confirm the
  // exclusion is also cryptographically real, not just an ACL veil: even
  // reading the raw stored value directly and attempting to decrypt it as
  // the outsider must fail to recover the plaintext.
  const outsiderView = await outsider.get(msgId);
  assert.equal(outsiderView, null, 'a non-reader gets nothing back — filtered before decryption is even attempted');

  const raw = await owner.runtime.get(msgId);
  assert.equal(raw.value.__qu_enc, 1, 'stored value is genuinely ciphertext');
  assert.ok(!JSON.stringify(raw.value).includes('group secret'), 'ciphertext must not leak the plaintext');
  const outsiderDecrypt = await decryptWith(outsider.identity, raw.value);
  assert.equal(outsiderDecrypt, undefined, 'the outsider has no wrapped key entry — decryption itself must fail, not just the ACL check');
});

test('explicit encryptFor opts out of the default (null and [] both mean "write in plaintext")', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const reader = await Qu.create({ runtime: owner.runtime });
  const readers = [owner.fingerprint, reader.fingerprint];
  const room = owner.createSpace({ writers: readers, readers });
  await room.ready;

  const a = await room.get('plain1').put('visible', { encryptFor: null });
  const b = await room.get('plain2').put('also visible', { encryptFor: [] });

  assert.equal((await owner.runtime.get(a.qubit.id)).value, 'visible');
  assert.equal((await owner.runtime.get(b.qubit.id)).value, 'also visible');
});

test('the Space manifest itself and reserved profile leaves are never auto-encrypted, even inside a restricted-readers Space', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const reader = await Qu.create({ runtime: owner.runtime });
  const readers = [owner.fingerprint, reader.fingerprint];
  const room = owner.createSpace({ writers: readers, readers });
  await room.ready;

  const manifest = await owner.runtime.get(room.id);
  assert.notEqual(manifest.value.__qu_enc, 1, 'the manifest must stay plaintext — getACL() reads it raw');
  assert.deepEqual(manifest.value.readers, readers);

  await owner.publishProfile({ alias: 'Owner' }); // owner's OWN Space, unrelated to `room`'s readers — must stay public regardless
  const epub = await owner.runtime.get(`${userSpaceId(owner.fingerprint)}/epub`);
  assert.notEqual(epub.value.__qu_enc, 1, 'epub must stay plaintext — otherwise nobody could ever discover it to encrypt for this user');
});

test('revoking a member takes effect immediately: future writes are denied, future reads exclude them — already-delivered messages are unaffected', async () => {
  const owner = (await Qu.create()).use(createSpacesPlugin());
  const member = await Qu.create({ runtime: owner.runtime });
  await Promise.all([owner, member].map((qu) => qu.publishProfile()));

  const readers = [owner.fingerprint, member.fingerprint];
  const room = owner.createSpace({ writers: readers, readers });
  await room.ready;

  const before = await room.get('msgs').set({ text: 'while still a member' });
  assert.equal((await member.get(before.qubit.id)).value.text, 'while still a member');

  // Revoke: member is removed from both writers and readers.
  await room.put({ admins: [owner.fingerprint], writers: [owner.fingerprint], readers: [owner.fingerprint] });

  await assert.rejects(() => member.get(room.id).get('msgs').get('x').put('member tries to write after revoke'));

  const after = await room.get('msgs').set({ text: 'after revoke, member-only' });
  const memberView = await member.get(after.qubit.id);
  assert.equal(memberView, null, 'a revoked reader must not see new messages');

  // The message from before the revoke is untouched — revocation is not retroactive.
  const stillThere = await owner.get(before.qubit.id);
  assert.equal(stillThere.value.text, 'while still a member');
});
