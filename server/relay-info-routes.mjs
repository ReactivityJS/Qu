// One tiny, public, read-only endpoint: this relay's own fingerprint +
// ECDH public key (JWK) — the exact pair `~<fp>/epub` already publishes
// via Qu#publishProfile() (relay/relay.mjs), just reachable WITHOUT first
// having to sync that path over a live connection. Not a new secret: a
// fingerprint/public key is never confidential by this codebase's own
// model (see modules/profiles.js's directory doc) — this only saves a
// client (e.g. examples/relay-admin) a network round trip + a
// subscribe-to-sync dance before it can `encryptFor([relayFingerprint])`
// its very first admin command.
export function createRelayInfoRoutes({ fingerprint, epub }) {
  return [{
    match: (p) => p === '/relay/info',
    handle: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ fingerprint, epub }));
    },
  }];
}
