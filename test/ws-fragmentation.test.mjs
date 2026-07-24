import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { handleUpgrade } from '../relay/ws-server.mjs';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function maskedFrame({ opcode, fin, payload }) {
  const body = Buffer.from(payload);
  const maskKey = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) masked[i] = body[i] ^ maskKey[i % 4];

  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, maskKey, masked]);
}

async function rawWebSocketHandshake(server) {
  const port = server.address().port;
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));

  const key = crypto.randomBytes(16).toString('base64');
  socket.write(
    `GET /ws HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${port}\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n\r\n`,
  );

  const response = await new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    socket.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (buf.includes('\r\n\r\n')) { socket.removeListener('data', onData); resolve(buf); }
    });
  });
  assert.ok(response.toString('utf8').startsWith('HTTP/1.1 101'), 'handshake must succeed before we test frame parsing');
  return socket;
}

// node:test's own promise-tracking produces a false-positive
// ("Promise resolution is still pending but the event loop has already
// resolved") when awaiting server.close(callback) after destroying a
// socket that was hijacked out of http.Server's normal connection
// tracking (exactly what a WebSocket upgrade does). unref()-ing both
// before closing releases the handles (the process can exit) without
// awaiting anything node:test gets confused by.
function closeQuietly(server, socket) {
  socket.unref();
  socket.destroy();
  server.unref();
  server.close();
}

test('a message split across an initial frame (fin=0) and a continuation frame (fin=1) is reassembled correctly, not truncated', async (t) => {
  const received = [];
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, (channel) => {
      channel.onMessage((msg) => received.push(msg));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.unref()); // belt-and-suspenders: an assertion below could throw before this test's own closeQuietly() call — unref() alone (no close() needed here, see closeQuietly()'s doc) is enough to stop this listening server from keeping `node --test` alive forever

  const socket = await rawWebSocketHandshake(server);

  const fullText = JSON.stringify({ type: 'test.large', payload: 'x'.repeat(500) });
  const half = Math.floor(fullText.length / 2);
  const part1 = fullText.slice(0, half);
  const part2 = fullText.slice(half);

  // First fragment: opcode 0x1 (text), fin=0 — "more to come".
  socket.write(maskedFrame({ opcode: 0x1, fin: false, payload: part1 }));
  // Final fragment: opcode 0x0 (continuation), fin=1 — "that's everything".
  socket.write(maskedFrame({ opcode: 0x0, fin: true, payload: part2 }));

  await new Promise((r) => setTimeout(r, 150));

  assert.equal(received.length, 1, 'the two fragments must be dispatched as exactly one message, not zero (dropped) or two (mis-split)');
  assert.deepEqual(received[0], JSON.parse(fullText));
  closeQuietly(server, socket);
});

test('three fragments (fin=0, fin=0, fin=1) reassemble correctly', async (t) => {
  const received = [];
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, (channel) => {
      channel.onMessage((msg) => received.push(msg));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.unref());
  const socket = await rawWebSocketHandshake(server);

  const fullText = JSON.stringify({ type: 'test.three', a: 'y'.repeat(300) });
  const third = Math.ceil(fullText.length / 3);
  const parts = [fullText.slice(0, third), fullText.slice(third, third * 2), fullText.slice(third * 2)];

  socket.write(maskedFrame({ opcode: 0x1, fin: false, payload: parts[0] }));
  socket.write(maskedFrame({ opcode: 0x0, fin: false, payload: parts[1] }));
  socket.write(maskedFrame({ opcode: 0x0, fin: true, payload: parts[2] }));

  await new Promise((r) => setTimeout(r, 150));

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], JSON.parse(fullText));
  closeQuietly(server, socket);
});

test('an unfragmented message still works exactly as before (regression guard)', async (t) => {
  const received = [];
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, (channel) => {
      channel.onMessage((msg) => received.push(msg));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.unref());
  const socket = await rawWebSocketHandshake(server);

  socket.write(maskedFrame({ opcode: 0x1, fin: true, payload: JSON.stringify({ type: 'plain', ok: true }) }));
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { type: 'plain', ok: true });
  closeQuietly(server, socket);
});
