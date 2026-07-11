const ENC = new TextEncoder();
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

  async sign(data) {
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.#signKP.privateKey, ENC.encode(data));
    return toHex(sig);
  }

  async exportPublicSigningKey() {
    return crypto.subtle.exportKey('jwk', this.#signKP.publicKey);
  }

  async exportKeys() {
    return {
      signPub: await crypto.subtle.exportKey('jwk', this.#signKP.publicKey),
      signPriv: await crypto.subtle.exportKey('jwk', this.#signKP.privateKey),
      encPub: await crypto.subtle.exportKey('jwk', this.#encKP.publicKey),
      encPriv: await crypto.subtle.exportKey('jwk', this.#encKP.privateKey),
    };
  }

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

export async function verifySignature(data, sigHex, pubKey) {
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, fromHex(sigHex), ENC.encode(data));
  } catch {
    return false;
  }
}

export { toHex, fromHex };
