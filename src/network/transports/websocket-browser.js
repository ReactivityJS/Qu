import { safeInvoke } from '../../core/channel.js';
import { debug } from '../../core/debug.js';
import { createHeartbeat } from '../../core/heartbeat.js';

// Browser-side Channel (core/channel.js contract) over a native WebSocket.
// Runs only in a browser (or any environment with a global WebSocket
// client) — this is a transport Plugin, same standing as
// createLoopbackChannelPair, just for real cross-process connections.
//
// `heartbeat` (default true): see core/heartbeat.js for why this exists —
// detects a relay connection that's gone zombie (no `close` event, but
// nothing ever answers again either) and force-closes it so the normal
// reconnect path takes over, instead of every in-flight request silently
// timing out on its own, one at a time. Opt out with `{ heartbeat: false }`
// for a transport where that doesn't make sense (a test loopback-like use,
// or a deployment that already has its own keepalive at a lower layer).
export function createWebSocketChannel(url, { heartbeat = true, heartbeatIntervalMs } = {}) {
  let ws = null;
  let closed = false;
  const messageListeners = new Set();
  const closeListeners = new Set();
  let pending = [];

  const dispatch = (obj) => {
    if (messageListeners.size === 0) { pending.push(obj); return; }
    messageListeners.forEach((fn) => safeInvoke(fn, obj, 'ws-client'));
  };

  const hb = heartbeat ? createHeartbeat({
    send: (msg) => { if (!closed && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
    onTimeout: () => { debug('ws-client', 'heartbeat-timeout', { url }); ws?.close(); },
    ...(heartbeatIntervalMs ? { intervalMs: heartbeatIntervalMs } : {}),
  }) : null;

  return {
    id: `ws-client-${Math.random().toString(36).slice(2)}`,

    connect() {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(url);
        ws.addEventListener('open', () => { debug('ws-client', 'open', { url }); hb?.start(); resolve(); }, { once: true });
        ws.addEventListener('error', (e) => reject(new Error(`[WebSocketChannel] connection failed: ${e.message || 'unknown error'}`)), { once: true });
        ws.addEventListener('message', (ev) => {
          let obj;
          try { obj = JSON.parse(ev.data); } catch (e) { debug('ws-client', 'parse-error', { error: e.message }); return; }
          if (hb?.handleIncoming(obj)) return; // ping/pong — never forwarded to real listeners
          debug('ws-client', 'message-in', { type: obj?.type, bytes: ev.data.length });
          dispatch(obj);
        });
        ws.addEventListener('close', () => {
          closed = true;
          hb?.stop();
          debug('ws-client', 'close', { url });
          closeListeners.forEach((fn) => fn());
        });
      });
    },

    async send(obj) {
      if (closed || !ws || ws.readyState !== WebSocket.OPEN) return;
      debug('ws-client', 'message-out', { type: obj?.type });
      ws.send(JSON.stringify(obj));
    },

    /** Proactive check, not just reacting to the 'close' event — a mobile OS can drop a background connection well before the browser notices/fires close. */
    isOpen() { return !closed && !!ws && ws.readyState === WebSocket.OPEN; },

    // See relay/ws-server.mjs for why this buffers instead of dropping.
    onMessage(fn) {
      messageListeners.add(fn);
      if (pending.length) {
        const buffered = pending;
        pending = [];
        for (const obj of buffered) messageListeners.forEach((f) => safeInvoke(f, obj, 'ws-client'));
      }
      return () => messageListeners.delete(fn);
    },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },

    async close() {
      if (!closed) { closed = true; ws?.close(); }
    },
  };
}
