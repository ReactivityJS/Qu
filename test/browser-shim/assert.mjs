function fail(message) {
  throw new Error(message || 'Assertion failed');
}

function deepEqualImpl(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqualImpl(a[k], b[k]));
  }
  return false;
}

const assert = {
  ok(value, message) {
    if (!value) fail(message || `Expected a truthy value, got ${value}`);
  },
  equal(actual, expected, message) {
    if (actual !== expected) fail(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  },
  notEqual(actual, expected, message) {
    if (actual === expected) fail(message || `Expected values to differ, both were ${JSON.stringify(actual)}`);
  },
  deepEqual(actual, expected, message) {
    if (!deepEqualImpl(actual, expected)) fail(message || 'Expected deep equality');
  },
  async rejects(fnOrPromise, message) {
    let threw = false;
    try {
      await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
    } catch {
      threw = true;
    }
    if (!threw) fail(message || 'Expected the promise/function to reject, but it resolved');
  },
  doesNotThrow(fn, message) {
    try {
      fn();
    } catch (e) {
      fail(message || `Expected no throw, but got: ${e.message}`);
    }
  },
};

export default assert;
