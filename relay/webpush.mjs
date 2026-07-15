import crypto from 'node:crypto';

// A from-scratch, dependency-free Web Push sender — VAPID (RFC 8292) +
// message encryption (RFC 8291, "aes128gcm" content-encoding per RFC 8188).
// No npm package: only `node:crypto` (ECDH/ECDSA/HKDF/AES-GCM, all present
// in Node's built-in crypto since well before this repo's minimum Node
// version, see package.json) and the built-in global `fetch` (Node 18+).
// Kept Node-only and outside src/ on purpose — same placement as
// node-ws-bridge.mjs: nothing here is part of the portable QU Core, it's
// this repo's own relay deployment concern (like FileSystemStorageAdapter).
//
// Deliberately unaware of QU/fingerprints/chat — `sendWebPush()` takes a
// plain Push API `subscription` object (whatever `PushManager.subscribe()`
// returned) and a plain JSON-serializable payload. Wiring "which
// fingerprint gets notified about which event" is relay.mjs's job, not
// this module's.

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

/**
 * A fresh VAPID keypair — `{ publicKey, privateKey }`, both base64url
 * strings. `publicKey` is the raw uncompressed P-256 point (65 bytes,
 * 0x04 prefix) exactly as `PushManager.subscribe({ applicationServerKey
 * })` expects on the browser side; `privateKey` is the raw 32-byte scalar.
 * Generate ONCE per deployment and keep both stable (see scripts/
 * generate-vapid-keys.mjs) — rotating them invalidates every subscription
 * a browser already holds.
 */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const publicKeyRaw = Buffer.concat([Buffer.from([0x04]), fromB64url(pubJwk.x), fromB64url(pubJwk.y)]);
  return { publicKey: b64url(publicKeyRaw), privateKey: privJwk.d };
}

/** Reconstructs a signable KeyObject from the raw `{ publicKey, privateKey }` pair above — Node's crypto needs a JWK/DER form, not the bare scalar, to sign with. */
function loadVapidPrivateKey({ publicKey, privateKey }) {
  const publicKeyRaw = fromB64url(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(publicKeyRaw.subarray(1, 33)), y: b64url(publicKeyRaw.subarray(33, 65)), d: privateKey };
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/** One VAPID JWT (RFC 8292 §2), ES256-signed, `aud` = the push service's own origin (not the subscriber's) — required to be re-derived per endpoint, never reused across different push services. Exported (alongside encryptPayload() below) purely so both can be tested directly against the RFCs without a real push service — sendWebPush() is still the one function an actual caller needs. */
export function buildVapidJWT({ audience, subject, vapidKeys, ttlSeconds = 12 * 3600 }) {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSeconds, sub: subject })));
  const unsigned = `${header}.${body}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), { key: loadVapidPrivateKey(vapidKeys), dsaEncoding: 'ieee-p1363' });
  return `${unsigned}.${b64url(signature)}`;
}

/**
 * Encrypts `payloadObj` (any JSON-serializable value) for exactly one Push
 * subscription, per RFC 8291 (key derivation) + RFC 8188 §2 "aes128gcm"
 * (the single-record wire format: 16-byte salt, 4-byte record size, 1-byte
 * keyid length, the keyid itself, then the AES-128-GCM ciphertext+tag —
 * everything the push service needs to hand onward, no separate headers).
 * `subscription.keys.{p256dh,auth}` are exactly what `PushSubscription.
 * toJSON().keys` already provides — never generated or chosen by this
 * module, always the subscriber's own.
 */
export function encryptPayload(payloadObj, subscription) {
  const plaintext = Buffer.from(JSON.stringify(payloadObj));
  const clientPublicKey = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);

  const serverECDH = crypto.createECDH('prime256v1');
  serverECDH.generateKeys();
  const serverPublicKey = serverECDH.getPublicKey();
  const sharedSecret = serverECDH.computeSecret(clientPublicKey);

  // Step 1 (RFC 8291 §3.3): an "authenticated" shared secret, salted with
  // the subscriber's own `auth` secret — without this, anyone who merely
  // observed `p256dh` (not secret) could forge a valid-looking payload.
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublicKey, serverPublicKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  // Step 2 (RFC 8188 §2.1): the actual content-encryption key + nonce, now
  // salted with a fresh RANDOM salt (must differ per message — reusing a
  // salt with the same ikm would let two messages leak their XOR).
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // `0x02`: the last-record delimiter (RFC 8188 §2, no padding needed for
  // a payload this small — a push message is always a single record).
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, recordSize, Buffer.from([serverPublicKey.length]), serverPublicKey]);
  return Buffer.concat([header, ciphertext]);
}

/**
 * Delivers one push message to one subscription. Throws on anything but a
 * 2xx from the push service (including 404/410, which per the Push API
 * spec means the subscription is gone — the caller should drop it; this
 * module deliberately doesn't guess that policy itself, see relay.mjs).
 */
export async function sendWebPush({ subscription, payload, vapidKeys, subject, ttlSeconds = 2_419_200 }) {
  const endpointOrigin = new URL(subscription.endpoint).origin;
  const jwt = buildVapidJWT({ audience: endpointOrigin, subject, vapidKeys });
  const body = encryptPayload(payload, subscription);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapidKeys.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`[WebPush] push service responded ${res.status}${text ? `: ${text}` : ''}`);
    error.status = res.status;
    throw error;
  }
  return { status: res.status };
}
