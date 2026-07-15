import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateVapidKeys, buildVapidJWT, encryptPayload } from './webpush.mjs';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

/**
 * The receiving side of encryptPayload() — what a browser's push service
 * implementation actually does with the "aes128gcm" wire format before
 * handing plaintext to a service worker's `push` event. Lives only here
 * (test-only): production code never needs to decrypt its own outgoing
 * messages, only a real subscriber does.
 */
function decryptForTest(wire, { subscriberECDH, authSecret }) {
  const salt = wire.subarray(0, 16);
  const recordSize = wire.readUInt32BE(16);
  const keyIdLen = wire.readUInt8(20);
  const serverPublicKey = wire.subarray(21, 21 + keyIdLen);
  const ciphertextAndTag = wire.subarray(21 + keyIdLen);
  assert.ok(recordSize > 0);

  const sharedSecret = subscriberECDH.computeSecret(serverPublicKey);
  const clientPublicKey = subscriberECDH.getPublicKey();
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), clientPublicKey, serverPublicKey]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16);
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(padded[padded.length - 1], 0x02); // last-record delimiter (RFC 8188 §2)
  return padded.subarray(0, padded.length - 1);
}

function fakeSubscription() {
  const subscriberECDH = crypto.createECDH('prime256v1');
  subscriberECDH.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const subscription = {
    endpoint: 'https://push.example.test/subscriptions/abc123',
    keys: { p256dh: b64url(subscriberECDH.getPublicKey()), auth: b64url(authSecret) },
  };
  return { subscription, subscriberECDH, authSecret };
}

test('generateVapidKeys() returns a valid raw P-256 keypair', () => {
  const keys = generateVapidKeys();
  const publicKeyRaw = fromB64url(keys.publicKey);
  assert.equal(publicKeyRaw.length, 65); // 0x04 + 32-byte x + 32-byte y
  assert.equal(publicKeyRaw[0], 0x04);
  assert.equal(fromB64url(keys.privateKey).length, 32);
});

test('buildVapidJWT() produces a structurally valid, ES256-verifiable JWT', () => {
  const vapidKeys = generateVapidKeys();
  const jwt = buildVapidJWT({ audience: 'https://push.example.test', subject: 'mailto:test@example.test', vapidKeys });
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(fromB64url(parts[0]));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(fromB64url(parts[1]));
  assert.equal(payload.aud, 'https://push.example.test');
  assert.equal(payload.sub, 'mailto:test@example.test');
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));

  const publicKeyRaw = fromB64url(vapidKeys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(publicKeyRaw.subarray(1, 33)), y: b64url(publicKeyRaw.subarray(33, 65)) };
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signature = fromB64url(parts[2]);
  const verified = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
  assert.equal(verified, true);
});

test('buildVapidJWT() signatures for different payloads do not verify against each other', () => {
  const vapidKeys = generateVapidKeys();
  const jwtA = buildVapidJWT({ audience: 'https://a.example.test', subject: 'mailto:x@example.test', vapidKeys });
  const otherVapidKeys = generateVapidKeys();
  const [h, p, s] = jwtA.split('.');
  const publicKeyRaw = fromB64url(otherVapidKeys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64url(publicKeyRaw.subarray(1, 33)), y: b64url(publicKeyRaw.subarray(33, 65)) };
  const wrongPublicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const verified = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: wrongPublicKey, dsaEncoding: 'ieee-p1363' }, fromB64url(s));
  assert.equal(verified, false);
});

test('encryptPayload() round-trips through the receiving side exactly (RFC 8291/8188)', () => {
  const { subscription, subscriberECDH, authSecret } = fakeSubscription();
  const payload = { title: 'Neue Nachricht', body: 'Alice hat dir geschrieben', fp: 'a1b2c3d4e5f60718293a4b5c' };
  const wire = encryptPayload(payload, subscription);
  assert.ok(Buffer.isBuffer(wire));
  assert.ok(wire.length > 21 + 65); // header (salt+recordSize+keyIdLen+keyId) + at least some ciphertext+tag

  const decrypted = decryptForTest(wire, { subscriberECDH, authSecret });
  assert.deepEqual(JSON.parse(decrypted.toString()), payload);
});

test('encryptPayload() uses a fresh salt/ephemeral key each call — two encryptions of the same payload differ', () => {
  const { subscription } = fakeSubscription();
  const wireA = encryptPayload({ x: 1 }, subscription);
  const wireB = encryptPayload({ x: 1 }, subscription);
  assert.notEqual(wireA.toString('hex'), wireB.toString('hex'));
});

test('encryptPayload() fails to decrypt with the WRONG subscriber (wrong ECDH key or auth secret)', () => {
  const { subscription } = fakeSubscription();
  const wire = encryptPayload({ secret: 'only for the real subscriber' }, subscription);

  const wrongSubscriber = fakeSubscription(); // a different subscriber's key material entirely
  assert.throws(() => decryptForTest(wire, { subscriberECDH: wrongSubscriber.subscriberECDH, authSecret: wrongSubscriber.authSecret }));
});
