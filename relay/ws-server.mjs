import crypto from 'node:crypto';
import { safeInvoke } from '../src/core/channel.js';
import { debug } from '../src/core/debug.js';
import { createHeartbeat } from '../src/core/heartbeat.js';

// Generic WebSocket server built on node:http's 'upgrade' event and raw
// sockets — no dependency, because the only thing we actually need is
// small JSON text frames, not the full feature surface a library like `ws`
// provides (permessage-deflate, extensions, strict RFC edge cases). This
// file knows nothing about QU; it hands the caller a plain object shaped
// like { id, send, onMessage, onClose, close } per connection — which
// happens to already satisfy the Channel contract (core/channel.js)
// without needing to import it here.

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024; // guard against a malformed/hostile length claim exhausting memory

function acceptKeyFor(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

/**
 * Incremental frame decoder — client→server frames are always masked per
 * RFC 6455. Handles fragmentation: a message can arrive as one frame
 * (opcode 0x1/0x2, fin=1) or split across an initial frame (fin=0) plus one
 * or more continuation frames (opcode 0x0), the last with fin=1. The first
 * version of this decoder ignored the FIN bit entirely and only recognised
 * opcode 0x1 — a fragmented message (plausible for a large single `send()`
 * of base64 image/file data, depending on the sending implementation)
 * would have its first fragment mis-parsed as a complete, truncated
 * message (silently dropped as invalid JSON) and every continuation frame
 * after it silently ignored. Fixed by buffering fragments until fin=1.
 */
class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #fragments = null; // Buffer[] while assembling a fragmented message
  #fragmentOpcode = null;

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames = [];
    let frame;
    while ((frame = this.#tryParseOne())) frames.push(frame);
    return frames;
  }

  #tryParseOne() {
    const buf = this.#buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    if (len > MAX_MESSAGE_BYTES) throw new Error(`[ws-server] frame length ${len} exceeds MAX_MESSAGE_BYTES`);

    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const unmasked = Buffer.alloc(len);
      for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }
    this.#buffer = buf.subarray(offset + len);

    if (opcode === 0x0) {
      // continuation of a fragmented message
      if (!this.#fragments) return { opcode: 0x0, payload, fin: true }; // stray continuation, nothing to assemble — let the caller ignore it
      this.#fragments.push(payload);
      if (!fin) return this.#tryParseOne();
      const assembled = Buffer.concat(this.#fragments);
      const finalOpcode = this.#fragmentOpcode;
      this.#fragments = null;
      this.#fragmentOpcode = null;
      return { opcode: finalOpcode, payload: assembled };
    }

    if (!fin && (opcode === 0x1 || opcode === 0x2)) {
      // start of a fragmented message
      this.#fragments = [payload];
      this.#fragmentOpcode = opcode;
      return this.#tryParseOne();
    }

    return { opcode, payload };
  }
}

/**
 * Call from an http.Server's 'upgrade' event. `onConnection(peer)` receives
 * one object per accepted connection: `{ id, send(obj), onMessage(fn),
 * onClose(fn), close() }` — JSON in, JSON out, already matching the shape
 * core/channel.js expects from a Channel (minus `connect()`, which is a
 * no-op on the server side since the connection already exists).
 */
export function handleUpgrade(req, socket, _head, onConnection) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKeyFor(key)}\r\n\r\n`,
  );

  const id = `relay-${crypto.randomUUID()}`;
  const decoder = new FrameDecoder();
  const messageListeners = new Set();
  const closeListeners = new Set();
  let pending = [];
  let closed = false;

  const dispatch = (obj) => {
    if (messageListeners.size === 0) { pending.push(obj); return; }
    messageListeners.forEach((fn) => safeInvoke(fn, obj, 'ws-server'));
  };

  const fireClose = () => {
    if (closed) return;
    closed = true;
    hb.stop();
    debug('ws-server', 'close', { id });
    closeListeners.forEach((fn) => fn());
  };

  // See src/core/heartbeat.js — detects a client whose socket never fires
  // 'close' even though it's long gone (dropped wifi mid-download, a
  // proxy/NAT mapping that silently expired), so relay.mjs's `connected`
  // map and file-mirror retries stop trusting a connection that will
  // never answer again, instead of only finding out once every in-flight
  // chunk request times out on its own, one at a time.
  const hb = createHeartbeat({
    send: (msg) => { if (!closed) socket.write(encodeFrame(JSON.stringify(msg))); },
    onTimeout: () => { debug('ws-server', 'heartbeat-timeout', { id }); socket.destroy(); },
  });

  socket.on('data', (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (e) {
      debug('ws-server', 'frame-error', { id, error: e.message });
      console.error(`[ws-server] ${id}: ${e.message} — closing connection`);
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 0x8) { socket.destroy(); return; }        // close
      if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.payload, 0xA)); continue; } // ping -> pong
      if (frame.opcode === 0x1) {                                  // text (now correctly reassembled if it was fragmented)
        const text = frame.payload.toString('utf8');
        let obj;
        try { obj = JSON.parse(text); } catch (e) {
          debug('ws-server', 'parse-error', { id, bytes: frame.payload.length, error: e.message });
          continue;
        }
        if (hb.handleIncoming(obj)) continue; // ping/pong — never forwarded to real listeners
        debug('ws-server', 'message-in', { id, type: obj?.type, bytes: frame.payload.length });
        dispatch(obj);
      }
    }
  });
  socket.on('close', fireClose);
  socket.on('error', (e) => { debug('ws-server', 'socket-error', { id, error: e.message }); fireClose(); });

  debug('ws-server', 'connect', { id });
  hb.start(); // the connection already exists once handleUpgrade runs — no separate connect() step server-side

  onConnection({
    id,
    async connect() {}, // no-op: the connection already exists once handleUpgrade runs
    async send(obj) {
      if (closed) return;
      debug('ws-server', 'message-out', { id, type: obj?.type });
      socket.write(encodeFrame(JSON.stringify(obj)));
    },
    // Messages that arrived before any consumer called onMessage() are
    // buffered, not dropped — a slow-to-register consumer (e.g. one that
    // awaits key generation before subscribing) would otherwise silently
    // lose the peer's opening handshake message. See handshake.js.
    onMessage(fn) {
      messageListeners.add(fn);
      if (pending.length) {
        const buffered = pending;
        pending = [];
        for (const obj of buffered) messageListeners.forEach((f) => safeInvoke(f, obj, 'ws-server'));
      }
      return () => messageListeners.delete(fn);
    },
    onClose(fn) { closeListeners.add(fn); return () => closeListeners.delete(fn); },
    async close() { if (!closed) { closed = true; hb.stop(); socket.destroy(); } },
  });
}
