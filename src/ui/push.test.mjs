import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPushSupported, registerServiceWorker, getExistingSubscription,
  publishPushSubscription, subscribeToPush, unsubscribeFromPush,
} from './push.mjs';

function withGlobals(globals, fn) {
  const originals = {};
  for (const key of Object.keys(globals)) {
    originals[key] = globalThis[key];
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true });
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(globals)) {
      Object.defineProperty(globalThis, key, { value: originals[key], configurable: true });
    }
  });
}

test('isPushSupported(): false when any of serviceWorker/PushManager/Notification is missing', async () => {
  await withGlobals({ navigator: {}, window: {}, Notification: undefined }, () => {
    assert.equal(isPushSupported(), false);
  });
});

test('isPushSupported(): true when all three are present', async () => {
  await withGlobals({ navigator: { serviceWorker: {} }, window: { PushManager: class {} }, Notification: class {} }, () => {
    assert.equal(isPushSupported(), true);
  });
});

test('registerServiceWorker(): returns null (not a throw) when serviceWorker is unsupported', async () => {
  await withGlobals({ navigator: {} }, async () => {
    assert.equal(await registerServiceWorker('/sw.js'), null);
  });
});

test('registerServiceWorker(): calls navigator.serviceWorker.register() with the given url/opts', async () => {
  const calls = [];
  await withGlobals({ navigator: { serviceWorker: { register: async (url, opts) => { calls.push([url, opts]); return { fake: true }; } } } }, async () => {
    const result = await registerServiceWorker('/sw.js', { scope: '/' });
    assert.deepEqual(calls, [['/sw.js', { scope: '/' }]]);
    assert.deepEqual(result, { fake: true });
  });
});

test('getExistingSubscription(): null when there is none, or when swRegistration itself is falsy', async () => {
  assert.equal(await getExistingSubscription(null), null);
  assert.equal(await getExistingSubscription({ pushManager: { getSubscription: async () => null } }), null);
});

test('getExistingSubscription(): returns whatever pushManager.getSubscription() resolves to', async () => {
  const fakeSub = { endpoint: 'https://push.example.test/x' };
  const result = await getExistingSubscription({ pushManager: { getSubscription: async () => fakeSub } });
  assert.equal(result, fakeSub);
});

function fakeQuAndRepl() {
  const published = [];
  const synced = [];
  const qu = { fingerprint: 'abc123', session: { publish: async (id, value) => { published.push({ id, value }); } } };
  const repl = { sync: async ({ topic }) => { synced.push(topic); } };
  return { qu, repl, published, synced };
}

test('publishPushSubscription(): publishes to push-subscription/<fp> and syncs the same topic', async () => {
  const { qu, repl, published, synced } = fakeQuAndRepl();
  const subscription = { endpoint: 'https://push.example.test/y' };
  await publishPushSubscription(qu, repl, subscription);
  assert.deepEqual(published, [{ id: 'push-subscription/abc123', value: subscription }]);
  assert.deepEqual(synced, ['push-subscription/abc123']);
});

test('publishPushSubscription(): publishing null clears the subscription (the unsubscribe convention)', async () => {
  const { qu, repl, published } = fakeQuAndRepl();
  await publishPushSubscription(qu, repl, null);
  assert.equal(published[0].value, null);
});

test('subscribeToPush(): throws without ever prompting, if no VAPID key is configured server-side', async () => {
  const { qu, repl } = fakeQuAndRepl();
  await assert.rejects(() => subscribeToPush(qu, repl, {}, null), /VAPID/);
});

test('subscribeToPush(): throws if the user denies the Notification permission prompt, never subscribes', async () => {
  const { qu, repl, published } = fakeQuAndRepl();
  let subscribeCalled = false;
  const swRegistration = { pushManager: { subscribe: async () => { subscribeCalled = true; return {}; } } };
  await withGlobals({ Notification: { requestPermission: async () => 'denied' } }, async () => {
    await assert.rejects(() => subscribeToPush(qu, repl, swRegistration, 'fake-vapid-key'), /denied/);
  });
  assert.equal(subscribeCalled, false, 'must never call pushManager.subscribe() if permission was denied');
  assert.equal(published.length, 0, 'must never publish anything if permission was denied');
});

test('subscribeToPush(): on granted permission, subscribes with the VAPID key converted to bytes, then publishes the subscription', async () => {
  const { qu, repl, published } = fakeQuAndRepl();
  let subscribeArgs = null;
  const fakeSubscription = { toJSON: () => ({ endpoint: 'https://push.example.test/new' }) };
  const swRegistration = { pushManager: { subscribe: async (opts) => { subscribeArgs = opts; return fakeSubscription; } } };
  await withGlobals({ Notification: { requestPermission: async () => 'granted' } }, async () => {
    const result = await subscribeToPush(qu, repl, swRegistration, 'AAAA'); // valid-enough base64url for the conversion helper
    assert.equal(result, fakeSubscription);
  });
  assert.equal(subscribeArgs.userVisibleOnly, true);
  assert.ok(subscribeArgs.applicationServerKey instanceof Uint8Array, 'applicationServerKey must be converted to raw bytes, not left as the base64url string');
  assert.deepEqual(published, [{ id: 'push-subscription/abc123', value: { endpoint: 'https://push.example.test/new' } }]);
});

test('unsubscribeFromPush(): unsubscribes an existing browser-level subscription AND clears the published one', async () => {
  const { qu, repl, published } = fakeQuAndRepl();
  let unsubscribeCalled = false;
  const swRegistration = { pushManager: { getSubscription: async () => ({ unsubscribe: async () => { unsubscribeCalled = true; } }) } };
  await unsubscribeFromPush(qu, repl, swRegistration);
  assert.equal(unsubscribeCalled, true);
  assert.deepEqual(published, [{ id: 'push-subscription/abc123', value: null }]);
});

test('unsubscribeFromPush(): no existing browser-level subscription is a harmless no-op for that part, still clears the published one', async () => {
  const { qu, repl, published } = fakeQuAndRepl();
  const swRegistration = { pushManager: { getSubscription: async () => null } };
  await unsubscribeFromPush(qu, repl, swRegistration);
  assert.deepEqual(published, [{ id: 'push-subscription/abc123', value: null }]);
});
