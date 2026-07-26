import fs from 'node:fs';
import path from 'node:path';
import { QuIdentity } from '../src/core/identity.js';

/**
 * A relay that regenerates a fresh, random identity on every restart is
 * unreachable-by-design for anything that needs to address IT specifically
 * (an admin encrypting a command "only the relay can read" — encryptFor()
 * needs a stable fingerprint/ECDH key to encrypt against — or any peer
 * that pinned the relay's fingerprint via trustPeer() once and expects it
 * to still mean the same relay after a deploy). Same "generate once,
 * persist to disk, reuse on every subsequent start" shape as index.js's
 * own `loadOrGenerateVapidKeys()` — QuIdentity.exportKeys()/importKeys()
 * (core/identity.js) already provide the exact round-trip this needs, this
 * is only the thin file-persistence wrapper around them.
 *
 * Only called in persistent mode (see index.js's `persistent` flag) — an
 * ephemeral (`QU_STORE=memory`) relay has no `.relay-data` directory at
 * all today, and forcing one into existence just for a stable identity
 * would be a footgun for a deployment that explicitly opted into "no disk
 * I/O, nothing survives a restart" (same reasoning index.js already
 * applies to the VAPID keypair in memory mode).
 */
export async function loadOrGenerateRelayIdentity(filePath) {
  let exported;
  try {
    exported = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    const identity = await QuIdentity.generate();
    exported = await identity.exportKeys();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(exported));
    return identity;
  }
  return QuIdentity.importKeys(exported.signPriv, exported.signPub, exported.encPriv, exported.encPub);
}
