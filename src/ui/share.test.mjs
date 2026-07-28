import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canShare, shareContent } from './share.mjs';

// A minimal, explicit navigator mock per test (restored after) — this
// module only ever touches `navigator.share`/`navigator.clipboard.writeText`
// behind feature-detect guards, so a plain mock object is enough; no jsdom
// needed.
function withNavigator(mock, fn) {
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: mock, configurable: true });
  return Promise.resolve(fn()).finally(() => {
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true });
  });
}

test('canShare(): false when navigator has no share()', async () => {
  await withNavigator({}, () => {
    assert.equal(canShare(), false);
  });
});

test('canShare(): true when navigator.share exists', async () => {
  await withNavigator({ share: async () => {} }, () => {
    assert.equal(canShare(), true);
  });
});

test('shareContent(): calls navigator.share() with the given fields, returns "shared" on success', async () => {
  const calls = [];
  await withNavigator({ share: async (opts) => { calls.push(opts); } }, async () => {
    const result = await shareContent({ title: 'T', text: 'X', url: 'https://example.com' });
    assert.equal(result, 'shared');
    assert.deepEqual(calls, [{ title: 'T', text: 'X', url: 'https://example.com' }]);
  });
});

test('shareContent(): a user-cancelled share sheet (AbortError) returns "cancelled", not a thrown error', async () => {
  await withNavigator({ share: async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; } }, async () => {
    const result = await shareContent({ title: 'T' });
    assert.equal(result, 'cancelled');
  });
});

test('shareContent(): any OTHER navigator.share() rejection is re-thrown, not swallowed', async () => {
  await withNavigator({ share: async () => { throw new Error('real failure'); } }, async () => {
    await assert.rejects(() => shareContent({ title: 'T' }), /real failure/);
  });
});

test('shareContent(): no Share API, falls back to clipboard — url preferred over text/title', async () => {
  const written = [];
  await withNavigator({ clipboard: { writeText: async (s) => { written.push(s); } } }, async () => {
    const result = await shareContent({ title: 'T', text: 'X', url: 'https://example.com' });
    assert.equal(result, 'copied');
    assert.deepEqual(written, ['https://example.com']);
  });
});

test('shareContent(): clipboard fallback uses text when url is absent, title when both are absent', async () => {
  const written = [];
  const mockClipboard = { clipboard: { writeText: async (s) => { written.push(s); } } };
  await withNavigator(mockClipboard, async () => {
    assert.equal(await shareContent({ text: 'just text' }), 'copied');
  });
  await withNavigator(mockClipboard, async () => {
    assert.equal(await shareContent({ title: 'just title' }), 'copied');
  });
  assert.deepEqual(written, ['just text', 'just title']);
});

test('shareContent(): neither Share API nor clipboard available returns "unsupported"', async () => {
  await withNavigator({}, async () => {
    const result = await shareContent({ title: 'T', url: 'https://example.com' });
    assert.equal(result, 'unsupported');
  });
});

test('shareContent(): nothing to share at all (title/text/url all empty) returns "noop", never calls anything', async () => {
  let called = false;
  await withNavigator({ clipboard: { writeText: async () => { called = true; } } }, async () => {
    const result = await shareContent({});
    assert.equal(result, 'noop');
    assert.equal(called, false);
  });
});
