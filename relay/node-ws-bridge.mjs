import { handleUpgrade } from './ws-server.mjs';

/**
 * The only Node-specific piece of relay wiring — opening a raw listening
 * socket isn't something a browser can do. Everything domain/app-related
 * still lives entirely outside this file: it just turns upgrade requests
 * into Channels and hands them to whatever relay (from relay.mjs) it's
 * given.
 */
export function bridgeWebSocketServer(httpServer, relayApi, { path = '/relay' } = {}) {
  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== path) return; // let something else handle it

    handleUpgrade(req, socket, head, async (channel) => {
      try {
        const { peerFingerprint } = await relayApi.attachChannel(channel);
        console.log(`[Relay] client connected: ${peerFingerprint ?? '(anonymous)'}  (${relayApi.connectedCount} online)`);
        channel.onClose(() => console.log(`[Relay] client disconnected  (${relayApi.connectedCount} remaining)`));
      } catch (e) {
        console.error('[Relay] handshake failed, dropping connection:', e.message);
        channel.close();
      }
    });
  });

  console.log(`[Relay] WebSocket bridge listening at ws://<host>${path} (relay fingerprint: ${relayApi.relay.fingerprint})`);
}
