// Shared ping/pong keepalive STATE MACHINE, used by both WebSocket
// transports (client: network/transports/websocket-browser.js; server:
// relay/ws-server.mjs) to detect a "zombie" connection — one whose
// underlying socket never fires `close` even though the peer is long
// gone (a phone that lost signal without a clean TCP FIN, an OS that
// silently drops a backgrounded socket, a NAT/proxy that dropped the
// mapping without telling either side). Without this, whatever's
// actually waiting on a reply over that connection only finds out once
// ITS OWN timeout eventually fires — for relay/relay.mjs's file-mirror
// retries (data/files/transfer.js's requestFile(): up to 6 attempts ×
// up to 10s each, PER missing chunk) that can mean many minutes before a
// sync that looks "stuck at some fixed percentage" is even recognized as
// talking to a dead connection, let alone retried against a fresh one.
//
// Deliberately an ordinary JSON message over the EXISTING Channel
// contract, not a raw WebSocket ping/pong frame: a browser's native
// WebSocket API answers protocol-level pings automatically and never
// exposes them to JS at all (no way to send one, no way to observe one
// arriving) — an application-level heartbeat is the only option that
// works identically for the browser client AND the Node server side.
//
// Deliberately just the timing/miss-detection state machine, not the
// actual message sending/dispatch wiring — the two transports' send()/
// dispatch() shapes are different enough (a native WebSocket object vs.
// a raw TCP socket + hand-rolled frame encoder) that unifying the wiring
// itself would cost more indirection than the ~15 duplicated lines it
// would save. `send(msg)` and `onTimeout()` are the only two things a
// caller has to provide; `handleIncoming(msg)` is the one thing every
// caller must run every incoming message through, before its own
// dispatch, so ping/pong traffic never leaks into DefaultReplication/
// DefaultFileTransfer/routed-events.
export const HEARTBEAT_PING = 'qu.heartbeat.ping';
export const HEARTBEAT_PONG = 'qu.heartbeat.pong';

/**
 * `intervalMs` (default 15s, matching this session's other retry
 * sweeps — relay.mjs's mirror sweep and chat/app.mjs's confirmDelivery()
 * sweep — for a consistent "how stale can state get" order of magnitude
 * across the whole retry story): a ping is sent every `intervalMs`. If
 * the PREVIOUS ping never got a pong by the time the next tick fires —
 * i.e. a full `intervalMs` of silence after already waiting one — the
 * connection is declared dead and `onTimeout()` fires once. Worst-case
 * detection latency is therefore under 2×`intervalMs`, not unbounded.
 */
export function createHeartbeat({ send, onTimeout, intervalMs = 15000 }) {
  let awaitingPong = false;
  let timer = null;

  function tick() {
    if (awaitingPong) { onTimeout(); return; } // no pong since the LAST ping — the connection is presumed dead
    awaitingPong = true;
    send({ type: HEARTBEAT_PING });
  }

  return {
    /** Run every incoming message through this FIRST. Returns true if it was heartbeat traffic (already fully handled — do not forward to your own dispatch). */
    handleIncoming(msg) {
      if (msg?.type === HEARTBEAT_PING) { send({ type: HEARTBEAT_PONG }); return true; }
      if (msg?.type === HEARTBEAT_PONG) { awaitingPong = false; return true; }
      return false;
    },
    start() {
      if (timer) return; // idempotent — a caller re-invoking start() (e.g. after a reconnect that reuses the same heartbeat instance) must not stack a second interval
      awaitingPong = false;
      timer = setInterval(tick, intervalMs);
      // Node-only; a browser timer id (a number) has no .unref(). Never
      // let a keepalive timer be the reason a process/test run can't
      // exit — the exact class of bug fixed elsewhere this session for
      // the file-mirror retry sweep.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
