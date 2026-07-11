import { debug } from './debug.js';

// Message listeners are frequently async (DefaultReplication#handleMessage,
// DefaultFileTransfer#handleMessage, authenticateChannel's handler). Calling
// an async function from a plain forEach does not catch a later rejection —
// that becomes an unhandled promise rejection, which in Node crashes the
// entire process by default. One listener's bug (e.g. a rejected verify/ACL
// check on an incoming push) must never be able to take down the whole
// relay and every other connection with it. Every Channel implementation
// routes its fan-out through this.
export function safeInvoke(fn, arg, scope) {
  try {
    const result = fn(arg);
    if (result && typeof result.catch === 'function') {
      result.catch((e) => {
        debug(scope, 'listener-error', e);
        console.error(`[${scope}] unhandled error in message listener:`, e);
      });
    }
  } catch (e) {
    debug(scope, 'listener-error', e);
    console.error(`[${scope}] error in message listener:`, e);
  }
}

// Channel is a Core concept, not a plugin concept: it's the minimal contract
// the Runtime and Modules are allowed to assume about "a way to move bytes
// to a peer". Concrete transports (WebSocket, WebRTC, HTTP-long-poll, an
// in-process loopback for tests) are Plugins that implement this contract.
// Nothing in Core or in a Module may depend on transport specifics beyond
// this shape.
//
//   connect()                 -> Promise<void>
//   send(message)              -> Promise<void>          message: plain JSON-serializable object
//   onMessage(handler)         -> unsubscribe()           handler(message)
//   onClose(handler)           -> unsubscribe()
//   close()                    -> Promise<void>
//   readonly id                                            stable peer/channel identifier
//
// This is intentionally duck-typed (no class hierarchy to extend) so a
// transport plugin can wrap literally anything. assertChannel() exists so
// Modules fail loudly and immediately if handed something that doesn't
// satisfy the contract, instead of failing confusingly three calls deep.
export function assertChannel(ch) {
  const required = ['connect', 'send', 'onMessage', 'onClose', 'close'];
  for (const m of required) {
    if (typeof ch[m] !== 'function') {
      throw new Error(`[Channel] Object does not satisfy the Channel contract: missing "${m}"`);
    }
  }
  if (typeof ch.id !== 'string' || !ch.id) {
    throw new Error('[Channel] Object does not satisfy the Channel contract: missing string "id"');
  }
  return ch;
}

/** Simple in-process channel pair, for tests and single-process multi-session demos. Not for production transport. */
export function createLoopbackChannelPair(idA = 'loopback-a', idB = 'loopback-b') {
  function makeSide(id) {
    const listeners = new Set();
    const closeListeners = new Set();
    let pending = [];
    return {
      side: {
        id,
        async connect() {},
        onMessage(fn) {
          listeners.add(fn);
          if (pending.length) {
            const buffered = pending;
            pending = [];
            for (const obj of buffered) listeners.forEach((f) => safeInvoke(f, obj, 'channel:loopback'));
          }
          return () => listeners.delete(fn);
        },
        onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
      },
      deliver(msg) {
        if (listeners.size === 0) { pending.push(msg); return; }
        listeners.forEach((fn) => safeInvoke(fn, msg, 'channel:loopback'));
      },
      fireClose() { closeListeners.forEach((fn) => fn()); },
    };
  }

  const sideA = makeSide(idA);
  const sideB = makeSide(idB);

  const a = {
    ...sideA.side,
    async send(msg) { queueMicrotask(() => sideB.deliver(msg)); },
    async close() { sideA.fireClose(); sideB.fireClose(); },
  };
  const b = {
    ...sideB.side,
    async send(msg) { queueMicrotask(() => sideA.deliver(msg)); },
    async close() { sideA.fireClose(); sideB.fireClose(); },
  };
  return { a: assertChannel(a), b: assertChannel(b) };
}
