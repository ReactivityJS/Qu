import { verifySignature, fingerprintOfPublicKey } from '../core/identity.js';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

function randomChallenge() {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Without this, `peerFingerprint` (used by filterForReader at every sync
 * boundary) was just a constructor argument someone had to already know and
 * trust out-of-band — the Zero-Trust chain broke exactly at the network
 * edge. This closes that: each side proves possession of the private key
 * behind its claimed identity by signing a challenge picked by the other
 * side, verified with the same fingerprint-binding check used for QuBits
 * (identity.js) — so a channel-level identity claim is held to the same
 * standard as a QuBit's `writer` claim, not a weaker one.
 *
 * Anonymous identities are allowed to skip proving themselves (server may
 * still choose not to trust them for reads/writes elsewhere), but a peer
 * that DOES claim an identity must prove it or the handshake rejects.
 */
export async function authenticateChannel(channel, identity = null, { timeoutMs = 8000 } = {}) {
  const myChallenge = randomChallenge();
  let resolveTheirs, rejectTheirs;
  const theirsPromise = new Promise((res, rej) => { resolveTheirs = res; rejectTheirs = rej; });
  const timer = setTimeout(() => rejectTheirs(new Error('[Handshake] Timed out waiting for peer proof')), timeoutMs);

  const off = channel.onMessage(async (msg) => {
    if (msg.type === 'qu.auth.hello') {
      if (!identity) { await channel.send({ type: 'qu.auth.proof', writer: null }); return; }
      const sig = await identity.sign(msg.challenge);
      const pubKey = await identity.exportPublicSigningKey();
      await channel.send({ type: 'qu.auth.proof', writer: identity.fingerprint, sig, pubKey });
      return;
    }
    if (msg.type === 'qu.auth.proof') {
      clearTimeout(timer);
      if (!msg.writer) { resolveTheirs(null); return; }
      try {
        const pubKey = await crypto.subtle.importKey('jwk', msg.pubKey, ECDSA, true, ['verify']);
        const derivedFp = await fingerprintOfPublicKey(pubKey);
        if (derivedFp !== msg.writer) throw new Error('fingerprint mismatch');
        const valid = await verifySignature(myChallenge, msg.sig, pubKey);
        if (!valid) throw new Error('invalid proof signature');
        resolveTheirs(msg.writer);
      } catch (e) {
        rejectTheirs(new Error(`[Handshake] Peer proof rejected: ${e.message}`));
      }
    }
  });

  try {
    await channel.send({ type: 'qu.auth.hello', challenge: myChallenge });
    return await theirsPromise;
  } finally {
    // Must also run if send() itself throws (e.g. the channel is already
    // closing) — previously the try only wrapped theirsPromise, so a
    // throwing send() skipped off() entirely and left this onMessage
    // listener (plus the pending setTimeout until it fires into nothing)
    // registered on the channel forever.
    clearTimeout(timer);
    off();
  }
}
