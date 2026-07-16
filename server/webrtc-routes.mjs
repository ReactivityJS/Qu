// Serves the ICE server list a browser needs before it can build an
// RTCPeerConnection for a direct call — same "escape hatch for anything
// that isn't a static file" mechanism as server/push-routes.mjs. A public
// STUN server alone (the framework's DEFAULT_ICE_SERVERS,
// src/network/transports/webrtc-browser.js) only ever produces a working
// connection when at least one side has a directly reachable (or
// STUN-reflexive) address — many real networks (mobile carrier-grade NAT,
// symmetric NAT, restrictive corporate firewalls) need a TURN relay
// instead, which by nature requires an operator's own server + credentials
// (there is no free public equivalent of Cloudflare's STUN server for
// TURN, since relaying media costs real bandwidth). This route lets a
// deployment opt in via env vars (index.js) without the client needing to
// know anything beyond "ask the server what to use".

/**
 * `iceServers`: the array to hand an RTCPeerConnection (or `[]`/only-STUN
 * if this deployment has no TURN server configured — calls between peers
 * that can't reach each other directly will then fail to connect, same as
 * today).
 */
export function createWebRTCRoutes({ iceServers = [] } = {}) {
  return [
    {
      match: (p) => p === '/webrtc/ice-servers',
      handle: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ iceServers }));
      },
    },
  ];
}
