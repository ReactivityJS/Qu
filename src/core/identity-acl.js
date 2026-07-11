import { spaceIdOf, isUserSpaceId, fingerprintOfUserSpace } from './space.js';

/**
 * The zero-config default ACL policy — what `Qu.create()` wires in before
 * any plugin runs. Not a placeholder "permissive until configured"
 * fallback: this is the one ACL fact that's structural to Identity itself,
 * not a policy choice an app makes — fingerprint = hash(pubKey) (identity.js)
 * already means you and only you can ever produce a valid signature for
 * `writer = <your fingerprint>`, so "you may write under `~<your
 * fingerprint>`" costs nothing to grant and requires no manifest, no
 * Storage round-trip, not even the concept of a Space beyond the id-parsing
 * helpers already in space.js.
 *
 * Everything else — generic (non-User) Spaces, additional writers granted
 * on top of a User-Space via a manifest, readers/admins lists — is a real
 * policy decision, not a structural one, and belongs to the Spaces plugin
 * (modules/spaces.js's createSpacesPlugin()), not here. Without that
 * plugin: nobody may write anywhere except their own `~<fingerprint>/**`,
 * and every user-space stays readable by anyone by default, matching
 * User-Spaces' long-standing default elsewhere in the codebase.
 */
export function createIdentityACL() {
  return async function getACL(id) {
    const spaceId = spaceIdOf(id);
    if (!isUserSpaceId(spaceId)) return { writers: [], readers: ['*'] };
    return { writers: [fingerprintOfUserSpace(spaceId)], readers: ['*'] };
  };
}
