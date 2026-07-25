const ENC = new TextEncoder();
// ECDSA (signing) and ECDH (encryption) are deliberately TWO SEPARATE
// keypairs, not one key reused for both — mixing a single keypair's
// algorithm across signing and key-agreement is a well-known way to leak
// information between the two uses (and the WebCrypto API itself refuses
// to import/generate a key usable for both anyway). P-256 over Ed25519:
// the only curve WebCrypto (SubtleCrypto) implements natively in every
// major browser — no polyfill/WASM dependency, which matters here since
// this is meant to run zero-dependency in the browser, not just Node.
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((b) => parseInt(b, 16)));
}

// Fingerprint is *always* derived from the public signing key. This is the
// one fact the verify plugin trusts, and it's what closes the identity-
// spoofing hole from the previous draft (writer field is never taken on faith).
export async function fingerprintOfSpki(spkiBuf) {
  const hash = await crypto.subtle.digest('SHA-256', spkiBuf);
  return toHex(hash).slice(0, 24);
}

export async function fingerprintOfPublicKey(pubKey) {
  const spki = await crypto.subtle.exportKey('spki', pubKey);
  return fingerprintOfSpki(spki);
}

const FINGERPRINT_RE = /^[0-9a-f]{24}$/i;

/**
 * Is `value` a plausible QU fingerprint — 24 hex characters, matching
 * `fingerprintOfSpki()`'s own `toHex(hash).slice(0, 24)` above? A shape
 * check only (no cryptographic verification, no lookup) — the same check
 * examples/chat/chat-lib.mjs's and examples/people/people-lib.mjs's own
 * copies already did before this existed; canonicalized here now that a
 * third caller (ui/people-search-components.js) needs it too, so every
 * caller stays in sync with the one place that actually derives the
 * format.
 */
export function isValidFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value.trim());
}

/**
 * One identity = one signing keypair (proves "this QuBit really came from
 * me", checked by every peer via verifySignature() below) + one encryption
 * keypair (lets others address ciphertext AT this identity specifically,
 * via ECDH — see core/crypto.js's key-agreement usage). Both private keys
 * stay inside this instance; `exportKeys()` is the one deliberate escape
 * hatch, for identity transfer between devices (modules/identity-transfer.js)
 * — nothing else in the framework reaches into `#signKP`/`#encKP` directly.
 */
export class QuIdentity {
  #signKP;
  #encKP;
  #fp = null;

  constructor(signKP, encKP) {
    this.#signKP = signKP;
    this.#encKP = encKP;
  }

  get publicKey() { return this.#signKP.publicKey; }
  get privateKey() { return this.#signKP.privateKey; }
  get encryptionKey() { return this.#encKP.publicKey; }
  get encryptionPrivateKey() { return this.#encKP.privateKey; }
  get fingerprint() { return this.#fp; }

  static async generate() {
    const signKP = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
    const encKP = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
    const id = new QuIdentity(signKP, encKP);
    id.#fp = await fingerprintOfPublicKey(signKP.publicKey);
    return id;
  }

  /** Hex, not base64/raw bytes — signatures travel inside JSON QuBits (core/session.js's publish/ingest), and hex needs no escaping or a Buffer/Uint8Array-aware serializer to round-trip safely through JSON.stringify()/parse(). */
  async sign(data) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.#signKP.privateKey, ENC.encode(data));
    return toHex(sig);
  }

  /** Just the PUBLIC signing key, JWK — what this identity hands to a peer so THEY can verifySignature() its writes; never includes anything private. Distinct from exportKeys() below, which is for moving this identity itself to another device. */
  async exportPublicSigningKey() {
    return crypto.subtle.exportKey('jwk', this.#signKP.publicKey);
  }

  /**
   * All four keys (both keypairs, public+private each), JWK format — the
   * one full-identity escape hatch (see class doc above), meant for
   * modules/identity-transfer.js to serialize/encrypt/hand to another
   * device. JWK over raw/pkcs8 bytes: it round-trips through JSON without
   * any binary-to-text encoding step of its own, and `importKey('jwk', ...)`
   * accepts exactly what `exportKey('jwk', ...)` produces — no format
   * conversion needed on either side of the transfer.
   */
  async exportKeys() {
    return {
      signPub: await crypto.subtle.exportKey('jwk', this.#signKP.publicKey),
      signPriv: await crypto.subtle.exportKey('jwk', this.#signKP.privateKey),
      encPub: await crypto.subtle.exportKey('jwk', this.#encKP.publicKey),
      encPriv: await crypto.subtle.exportKey('jwk', this.#encKP.privateKey),
    };
  }

  /** The inverse of exportKeys() — same four JWKs back in, same positional order, reconstructing an identity whose fingerprint (derived from signPub, see fingerprintOfPublicKey() above) is identical to the original's. */
  static async importKeys(signPriv, signPub, encPriv, encPub) {
    const signKP = {
      privateKey: await crypto.subtle.importKey('jwk', signPriv, ECDSA, true, ['sign']),
      publicKey: await crypto.subtle.importKey('jwk', signPub, ECDSA, true, ['verify']),
    };
    const encKP = {
      privateKey: await crypto.subtle.importKey('jwk', encPriv, ECDH, true, ['deriveBits']),
      publicKey: await crypto.subtle.importKey('jwk', encPub, ECDH, true, []),
    };
    const id = new QuIdentity(signKP, encKP);
    id.#fp = await fingerprintOfPublicKey(signKP.publicKey);
    return id;
  }
}

/** Fails CLOSED, not open — a malformed hex string, a key of the wrong algorithm, or any other SubtleCrypto exception here means "not verified", the same outcome as an actually-wrong signature, never an uncaught throw that could let a caller accidentally skip the check. */
export async function verifySignature(data, sigHex, pubKey) {
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, fromHex(sigHex), ENC.encode(data));
  } catch {
    return false;
  }
}

export { toHex, fromHex };
