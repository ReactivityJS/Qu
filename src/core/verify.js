import { verifySignature, fingerprintOfPublicKey } from './identity.js';
import { canonical } from './sign.js';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

/**
 * Zero-Trust verify middleware.
 *
 * The v4.3.5 draft's verify plugin would import whatever pubKey was attached
 * to the incoming qubit and check the signature against it, WITHOUT ever
 * confirming that `writer` (the claimed fingerprint) actually corresponds to
 * that pubKey. That let anyone self-sign a qubit while declaring an
 * arbitrary `writer` value, as long as the verifier didn't already have that
 * fingerprint pinned in its `known` map — which, on a fresh relay with no
 * prior state, is every writer.
 *
 * Fingerprint = hash(pubKey) by construction (see identity.js). This plugin
 * enforces that binding: it recomputes the fingerprint from whatever pubKey
 * is presented and rejects the qubit if it doesn't match the claimed
 * `writer`. Given SHA-256 preimage resistance, the only way to legitimately
 * produce a qubit with writer=F is to hold the private key whose public key
 * hashes to F — i.e. actual possession, not a claim.
 *
 * `known` is an optional pinned-identity cache (skip re-import/re-hash for
 * frequently seen writers) — it is a performance optimization here, not the
 * source of trust. The source of trust is the hash binding itself, so
 * verification works correctly even for writers never seen before.
 */
export function createVerifyPlugin(known = {}) {
  return async (ctx, next) => {
    const q = ctx.qubit;
    if (!q.sig || !q.writer) {
      if (ctx.requireSignature) throw new Error('[Verify] Missing signature or writer');
      return next();
    }

    let pubKey = known[q.writer];
    if (!pubKey) {
      if (!q.pubKey) throw new Error(`[Verify] No public key available for writer ${q.writer}`);
      pubKey = await crypto.subtle.importKey('jwk', q.pubKey, ECDSA, true, ['verify']);
      const derivedFp = await fingerprintOfPublicKey(pubKey);
      if (derivedFp !== q.writer) {
        throw new Error(`[Verify] Fingerprint mismatch: claimed writer ${q.writer} does not match embedded key (${derivedFp})`);
      }
    }

    const valid = await verifySignature(canonical(q), q.sig, pubKey);
    if (!valid) throw new Error(`[Verify] Invalid signature from ${q.writer}`);
    await next();
  };
}
