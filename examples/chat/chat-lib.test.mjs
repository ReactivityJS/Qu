import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidFingerprint, normalizeFingerprint, dmRoomId, groupRoomId, inboxId, shortFp, fmtBytes,
  fmtTime, fmtDayLabel, fmtCallDuration, linkify, mediaKind, sortByActivity,
  buildInviteLink, parseInviteHash, buildChatHashRoute, parseChatHash,
} from './chat-lib.mjs';

const FP_A = 'a1b2c3d4e5f60718293a4b5c';
const FP_B = '0123456789abcdef01234567';

test('isValidFingerprint()/normalizeFingerprint()', () => {
  assert.equal(isValidFingerprint(FP_A), true);
  assert.equal(isValidFingerprint(FP_A.toUpperCase()), true);
  assert.equal(isValidFingerprint('too-short'), false);
  assert.equal(isValidFingerprint(''), false);
  assert.equal(isValidFingerprint(null), false);
  assert.equal(normalizeFingerprint(`  ${FP_A.toUpperCase()}  `), FP_A);
  assert.equal(normalizeFingerprint('nope'), null);
});

test('dmRoomId() is order-independent and deterministic', () => {
  const id1 = dmRoomId(FP_A, FP_B);
  const id2 = dmRoomId(FP_B, FP_A);
  assert.equal(id1, id2);
  assert.match(id1, /^dm-[0-9a-f]{24}-[0-9a-f]{24}$/);
});

test('dmRoomId() rejects invalid fingerprints', () => {
  assert.throws(() => dmRoomId(FP_A, 'not-a-fingerprint'));
});

test('groupRoomId() returns unique, differently-prefixed ids', () => {
  const a = groupRoomId();
  const b = groupRoomId();
  assert.match(a, /^grp-/);
  assert.notEqual(a, b);
});

test('inboxId()', () => {
  assert.equal(inboxId(FP_A), `inbox-${FP_A}`);
  assert.equal(inboxId(FP_A.toUpperCase()), `inbox-${FP_A}`);
  assert.throws(() => inboxId('not-a-fingerprint'));
});

test('shortFp()', () => {
  assert.equal(shortFp(FP_A), FP_A.slice(0, 8));
  assert.equal(shortFp(FP_A, 4), FP_A.slice(0, 4));
  assert.equal(shortFp(null), '');
});

test('fmtBytes()', () => {
  assert.equal(fmtBytes(500), '500 B');
  assert.equal(fmtBytes(2048), '2.0 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
});

test('fmtTime() is always HH:MM', () => {
  assert.match(fmtTime(Date.now()), /^\d{2}:\d{2}$/);
});

test('fmtCallDuration()', () => {
  assert.equal(fmtCallDuration(0), '0:00');
  assert.equal(fmtCallDuration(5), '0:05');
  assert.equal(fmtCallDuration(65), '1:05');
  assert.equal(fmtCallDuration(3600), '1:00:00');
  assert.equal(fmtCallDuration(3725), '1:02:05');
  assert.equal(fmtCallDuration(-5), '0:00'); // negative/garbage clamps instead of throwing or showing "-1:-5"
});

test('fmtDayLabel() with an injected "now"', () => {
  const now = new Date(2026, 6, 14, 10, 0, 0).getTime(); // 14. Juli 2026
  const today = new Date(2026, 6, 14, 9, 0, 0).getTime();
  const yesterday = new Date(2026, 6, 13, 23, 0, 0).getTime();
  const older = new Date(2026, 6, 1, 12, 0, 0).getTime();
  assert.equal(fmtDayLabel(today, now), 'Heute');
  assert.equal(fmtDayLabel(yesterday, now), 'Gestern');
  assert.equal(fmtDayLabel(older, now), '01.07.2026');
});

test('linkify() splits text/link segments in order', () => {
  const segs = linkify('schau mal https://example.com/x und https://foo.bar hier');
  assert.deepEqual(segs.map((s) => s.type), ['text', 'link', 'text', 'link', 'text']);
  assert.equal(segs[1].value, 'https://example.com/x');
  assert.equal(segs[1].hostname, 'example.com');
  assert.equal(segs[3].hostname, 'foo.bar');
});

test('linkify() with no links returns a single text segment', () => {
  const segs = linkify('nur text, kein link');
  assert.deepEqual(segs, [{ type: 'text', value: 'nur text, kein link' }]);
});

test('mediaKind()', () => {
  assert.equal(mediaKind('image/png'), 'image');
  assert.equal(mediaKind('video/mp4'), 'video');
  assert.equal(mediaKind('audio/mpeg'), 'audio');
  assert.equal(mediaKind('application/pdf'), 'file');
  assert.equal(mediaKind(undefined), 'file');
});

test('sortByActivity() sorts by lastTs desc, missing lastTs last, tie-break by alias', () => {
  const sorted = sortByActivity([
    { alias: 'Bea', lastTs: 100 },
    { alias: 'Zoe' },
    { alias: 'Amy' },
    { alias: 'Cid', lastTs: 200 },
  ]);
  assert.deepEqual(sorted.map((c) => c.alias), ['Cid', 'Bea', 'Amy', 'Zoe']);
});

test('buildInviteLink()/parseInviteHash() round-trip', () => {
  const link = buildInviteLink('https://chat.example/app.html', FP_A);
  assert.equal(link, `https://chat.example/app.html#add=${FP_A}`);
  const hash = link.slice(link.indexOf('#'));
  assert.equal(parseInviteHash(hash), FP_A);
});

test('parseInviteHash() returns null for garbage/missing hash', () => {
  assert.equal(parseInviteHash('#foo=bar'), null);
  assert.equal(parseInviteHash(''), null);
  assert.equal(parseInviteHash('#add=not-a-fingerprint'), null);
});

test('buildChatHashRoute()/parseChatHash() round-trip (roomId-based, current format)', () => {
  const hash = buildChatHashRoute('dm-abc-def');
  assert.equal(hash, '#room=dm-abc-def');
  assert.deepEqual(parseChatHash(hash), { roomId: 'dm-abc-def' });
  assert.deepEqual(parseChatHash('room=dm-abc-def'), { roomId: 'dm-abc-def' }); // auch ohne führendes '#' (z. B. schon von location.hash getrennt)
});

test('buildChatHashRoute() encodes/decodes special characters in a roomId round-trip', () => {
  const hash = buildChatHashRoute('grp-a b/c');
  assert.deepEqual(parseChatHash(hash), { roomId: 'grp-a b/c' });
});

test('parseChatHash() still understands a pre-refactor bare-fingerprint link as legacyFp', () => {
  assert.deepEqual(parseChatHash(`#${FP_A}`), { legacyFp: FP_A });
});

test('parseChatHash() never matches an invite hash or garbage', () => {
  assert.equal(parseChatHash(`#add=${FP_A}`), null);
  assert.equal(parseChatHash(''), null);
  assert.equal(parseChatHash('#not-a-fingerprint'), null);
});
