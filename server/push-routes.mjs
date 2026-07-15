// Serves the ONE non-secret piece of push configuration a browser needs
// before it can even ask for a subscription: the VAPID public key. Same
// "escape hatch for anything that isn't a static file" mechanism as
// server/test-runner.mjs's createTestRoutes() (see static-server.mjs) —
// kept as its own tiny module rather than folded into index.js so the
// route itself stays testable without spinning up the whole relay.

/**
 * `publicKey`: the base64url VAPID public key (relay/webpush.mjs's
 * `generateVapidKeys().publicKey`), or `null` if this deployment hasn't
 * configured push at all (see index.js's QU_VAPID_PUBLIC_KEY) — the
 * client checks for `null` and disables the "enable notifications" UI
 * instead of failing confusingly later at `pushManager.subscribe()`.
 */
export function createPushRoutes({ publicKey = null } = {}) {
  return [
    {
      match: (p) => p === '/push/vapid-public-key',
      handle: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ publicKey }));
      },
    },
  ];
}
