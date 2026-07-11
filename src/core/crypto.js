import { toB64, fromB64 } from './bytes.js';

const AESGCM = { name: 'AES-GCM', length: 256 };
const ECDH_ALG = { name: 'ECDH', namedCurve: 'P-256' };


// The old draft wrapped the content key with `sharedSecret XOR key` — no KDF,
// no authentication of the wrap itself. Here the ECDH shared secret is run
// through HKDF (domain-separated per recipient fingerprint) to derive a
// proper AES-GCM key, which is then used to *encrypt* (authenticated, not
// XOR) the content key. Tampering with the wrapped key now fails an auth
// tag check instead of silently producing a different — but plausible —
// unwrapped key.
async function deriveWrapKey(ecdhPrivateKey, ecdhPublicKey, salt, info) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: ecdhPublicKey }, ecdhPrivateKey, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    hkdfKey,
    AESGCM,
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * recipients: [{ fingerprint, ecdhPublicKey: CryptoKey }]
 * One ephemeral ECDH keypair per publish is used to derive a distinct
 * shared secret (and thus wrap key) per recipient via static-ephemeral ECDH
 * — a recipient not in `recipients` cannot derive any of the wrap keys, and
 * a recipient in the list can only unwrap the entry addressed to them.
 */
export async function encryptFor(recipients, plaintextValue) {
  const contentKey = await crypto.subtle.generateKey(AESGCM, true, ['encrypt', 'decrypt']);
  const contentIv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(plaintextValue));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: contentIv }, contentKey, plaintext);
  const rawContentKey = await crypto.subtle.exportKey('raw', contentKey);

  const ephemeral = await crypto.subtle.generateKey(ECDH_ALG, true, ['deriveBits']);
  const ephemeralPubJwk = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keys = {};
  for (const r of recipients) {
    const wrapKey = await deriveWrapKey(ephemeral.privateKey, r.ecdhPublicKey, salt, r.fingerprint);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, wrapKey, rawContentKey);
    keys[r.fingerprint] = { iv: toB64(wrapIv), wrapped: toB64(wrapped) };
  }

  return {
    __qu_enc: 1,
    alg: 'ECDH-P256+HKDF-SHA256+AES-256-GCM',
    ephemeralPubKey: ephemeralPubJwk,
    salt: toB64(salt),
    iv: toB64(contentIv),
    ciphertext: toB64(ciphertext),
    keys,
  };
}

/** Returns `undefined` if `identity` is not among the envelope's recipients (distinct from "decryption failed", which throws). */
export async function decryptWith(identity, envelope) {
  const entry = envelope.keys[identity.fingerprint];
  if (!entry) return undefined;
  const ephemeralPub = await crypto.subtle.importKey('jwk', envelope.ephemeralPubKey, ECDH_ALG, true, []);
  const salt = fromB64(envelope.salt);
  const wrapKey = await deriveWrapKey(identity.encryptionPrivateKey, ephemeralPub, salt, identity.fingerprint);
  const rawContentKey = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(entry.iv) }, wrapKey, fromB64(entry.wrapped));
  const contentKey = await crypto.subtle.importKey('raw', rawContentKey, AESGCM, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(envelope.iv) }, contentKey, fromB64(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(plaintext));
}
