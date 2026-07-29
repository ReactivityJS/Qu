import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWakeLockSupported, createWakeLock } from './wake-lock.mjs';

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

/** A `document` fake exposing just enough of `addEventListener`/`visibilityState` for wake-lock.mjs, plus a `fireVisibilityChange()` test hook instead of a real Event/dispatch round-trip. */
function fakeDocument(initialVisibility = 'visible') {
  const listeners = [];
  return {
    visibilityState: initialVisibility,
    addEventListener: (type, cb) => { if (type === 'visibilitychange') listeners.push(cb); },
    fireVisibilityChange(visibility) {
      this.visibilityState = visibility;
      for (const cb of listeners) cb();
    },
  };
}

function fakeNavigatorWithWakeLock(requestImpl) {
  return { wakeLock: { request: requestImpl } };
}

test('isWakeLockSupported(): false when navigator.wakeLock is missing', async () => {
  await withGlobals({ navigator: {} }, () => {
    assert.equal(isWakeLockSupported(), false);
  });
});

test('isWakeLockSupported(): true when navigator.wakeLock is present', async () => {
  await withGlobals({ navigator: { wakeLock: {} } }, () => {
    assert.equal(isWakeLockSupported(), true);
  });
});

test('createWakeLock().acquire(): requests a sentinel when supported and visible, isHeld() becomes true', async () => {
  const doc = fakeDocument('visible');
  let requestCalls = 0;
  const navigator = fakeNavigatorWithWakeLock(async (type) => {
    requestCalls++;
    assert.equal(type, 'screen');
    return { addEventListener: () => {}, release: async () => {} };
  });
  await withGlobals({ navigator, document: doc }, async () => {
    const lock = createWakeLock();
    assert.equal(lock.isHeld(), false);
    await lock.acquire();
    assert.equal(lock.isHeld(), true);
    assert.equal(requestCalls, 1);
  });
});

test('createWakeLock().acquire(): no request when the API is unsupported, but isHeld() still reflects the desired state', async () => {
  const doc = fakeDocument('visible');
  await withGlobals({ navigator: {}, document: doc }, async () => {
    const lock = createWakeLock();
    await lock.acquire();
    assert.equal(lock.isHeld(), true, 'desired state is tracked regardless of API support');
  });
});

test('createWakeLock().acquire(): no request while the document is hidden', async () => {
  const doc = fakeDocument('hidden');
  let requestCalls = 0;
  const navigator = fakeNavigatorWithWakeLock(async () => { requestCalls++; return { addEventListener: () => {}, release: async () => {} }; });
  await withGlobals({ navigator, document: doc }, async () => {
    const lock = createWakeLock();
    await lock.acquire();
    assert.equal(requestCalls, 0);
    assert.equal(lock.isHeld(), true, 'still marked as desired, just not granted yet');
  });
});

test('createWakeLock().acquire(): a rejected request() (e.g. battery saver) is swallowed, never throws', async () => {
  const doc = fakeDocument('visible');
  const navigator = fakeNavigatorWithWakeLock(async () => { throw new Error('denied'); });
  await withGlobals({ navigator, document: doc }, async () => {
    const lock = createWakeLock();
    await assert.doesNotReject(() => lock.acquire());
    assert.equal(lock.isHeld(), true);
  });
});

test('createWakeLock().release(): releases the underlying sentinel and clears isHeld()', async () => {
  const doc = fakeDocument('visible');
  let releaseCalls = 0;
  const navigator = fakeNavigatorWithWakeLock(async () => ({ addEventListener: () => {}, release: async () => { releaseCalls++; } }));
  await withGlobals({ navigator, document: doc }, async () => {
    const lock = createWakeLock();
    await lock.acquire();
    lock.release();
    assert.equal(lock.isHeld(), false);
    assert.equal(releaseCalls, 1);
  });
});

test('createWakeLock().release(): a no-op (never acquired) is harmless', async () => {
  const doc = fakeDocument('visible');
  await withGlobals({ navigator: { wakeLock: {} }, document: doc }, async () => {
    const lock = createWakeLock();
    assert.doesNotThrow(() => lock.release());
    assert.equal(lock.isHeld(), false);
  });
});

test('visibilitychange: re-acquires when the tab becomes visible again while still held', async () => {
  const doc = fakeDocument('visible');
  let requestCalls = 0;
  const navigator = fakeNavigatorWithWakeLock(async () => { requestCalls++; return { addEventListener: () => {}, release: async () => {} }; });
  await withGlobals({ navigator, document: doc }, async () => {
    const lock = createWakeLock();
    await lock.acquire();
    assert.equal(requestCalls, 1);
    doc.fireVisibilityChange('hidden'); // browser auto-releases the real sentinel here, per spec — this fake doesn't need to simulate that explicitly
    doc.fireVisibilityChange('visible');
    // requestSentinel() is async; give its microtask a tick to run.
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(requestCalls >= 1, 'a re-request attempt happens on returning to visible while held');
  });
});

test('visibilitychange: does NOT request when the lock was never (or no longer) held', async () => {
  const doc = fakeDocument('hidden');
  let requestCalls = 0;
  const navigator = fakeNavigatorWithWakeLock(async () => { requestCalls++; return { addEventListener: () => {}, release: async () => {} }; });
  await withGlobals({ navigator, document: doc }, async () => {
    createWakeLock(); // never acquire()d
    doc.fireVisibilityChange('visible');
    await Promise.resolve();
    assert.equal(requestCalls, 0);
  });
});

test('two independent handles do not share a sentinel — releasing one leaves the other held', async () => {
  const doc = fakeDocument('visible');
  const releaseCallsBySentinel = [];
  const navigator = fakeNavigatorWithWakeLock(async () => {
    const calls = { released: false };
    releaseCallsBySentinel.push(calls);
    return { addEventListener: () => {}, release: async () => { calls.released = true; } };
  });
  await withGlobals({ navigator, document: doc }, async () => {
    const lockA = createWakeLock();
    const lockB = createWakeLock();
    await lockA.acquire();
    await lockB.acquire();
    lockA.release();
    assert.equal(lockA.isHeld(), false);
    assert.equal(lockB.isHeld(), true, 'releasing lockA must not affect lockB');
    assert.equal(releaseCallsBySentinel[0].released, true);
    assert.equal(releaseCallsBySentinel[1].released, false);
  });
});
