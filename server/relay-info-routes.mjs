// One tiny, public, read-only endpoint: this relay's own fingerprint +
// ECDH public key (JWK) — the exact pair `~<fp>/epub` already publishes
// via Qu#publishProfile() (relay/relay.mjs), just reachable WITHOUT first
// having to sync that path over a live connection. Not a new secret: a
// fingerprint/public key is never confidential by this codebase's own
// model (see modules/profiles.js's directory doc) — this only saves a
// client (e.g. examples/relay-admin) a network round trip + a
// subscribe-to-sync dance before it can `encryptFor([relayFingerprint])`
// its very first admin command.
//
// `admins` (the configured QU_RELAY_ADMINS list) is included for the same
// "not actually a secret" reason — a fingerprint never is, in this
// codebase's model — and specifically so portal.mjs can show/hide the
// Relay-Admin card based on whether the VISITOR'S OWN locally-stored
// identity happens to be one of them, without needing any real
// authentication step just to decide what to display. This is a pure UI
// convenience, not a security boundary: the actual authorization is (and
// remains) the relay's write-time ACL check on `admin/`/`relay-services/`
// — see relay/relay.mjs. Publishing this list does mean any visitor can
// see WHICH fingerprints administer this relay (not who they belong to);
// operators who consider that too much operational detail to expose can
// simply not rely on the portal's convenience card and link directly to
// `/examples/relay-admin/index.html` instead.
// `getAdminConfig` (optional): relay/relay.mjs's own `getAdminConfig()` —
// the CURRENT effective rate-limit/connection-limit thresholds. Injected
// as a function (not a plain value) so this route always reads the LIVE
// config, including after an `admin/config/*` command has changed it —
// same "not actually a secret" reasoning as `admins` above: a numeric
// threshold or an allow-listed fingerprint reveals no more than the
// already-public admins list does (knowing a fingerprint never lets
// anyone impersonate it — that still requires the matching private key),
// so this stays a plain, unauthenticated GET, exactly like the rest of
// this file. The actual write path (changing these values) remains the
// signed+encrypted `admin/config/*` channel — this route is read-only.
export function createRelayInfoRoutes({ fingerprint, epub, admins = [], getAdminConfig = null }) {
  return [{
    match: (p) => p === '/relay/info',
    handle: (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ fingerprint, epub, admins, adminConfig: getAdminConfig?.() ?? null }));
    },
  }];
}
