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

// A plain string second argument to rejects()/throws() is a fail message
// (matching node:assert/strict's own disambiguation — it actually throws a
// TypeError if you pass a bare string as the error matcher, precisely to
// avoid this ambiguity); a RegExp/constructor is an error matcher instead.
function isMatcher(x) {
  return x instanceof RegExp || typeof x === 'function';
}

function matchesError(error, matcher) {
  if (matcher instanceof RegExp) return matcher.test(error?.message ?? String(error));
  if (typeof matcher === 'function') return error instanceof matcher;
  return true;
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
  match(value, regex, message) {
    if (!regex.test(value)) fail(message || `Expected "${value}" to match ${regex}`);
  },
  async rejects(fnOrPromise, errorOrMessage, maybeMessage) {
    const matcher = isMatcher(errorOrMessage) ? errorOrMessage : undefined;
    const message = matcher ? maybeMessage : errorOrMessage;
    let thrown = null;
    try {
      await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise);
    } catch (e) {
      thrown = e;
    }
    if (!thrown) fail(message || 'Expected the promise/function to reject, but it resolved');
    if (matcher && !matchesError(thrown, matcher)) fail(message || `Rejection did not match ${matcher}: ${thrown.message}`);
  },
  throws(fn, errorOrMessage, maybeMessage) {
    const matcher = isMatcher(errorOrMessage) ? errorOrMessage : undefined;
    const message = matcher ? maybeMessage : errorOrMessage;
    let thrown = null;
    try {
      fn();
    } catch (e) {
      thrown = e;
    }
    if (!thrown) fail(message || 'Expected function to throw, but it did not');
    if (matcher && !matchesError(thrown, matcher)) fail(message || `Thrown error did not match ${matcher}: ${thrown.message}`);
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
