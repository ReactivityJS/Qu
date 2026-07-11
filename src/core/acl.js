import { spaceIdOf } from './space.js';

// Write-time ACL: runs inside the commit pipeline, after verify, so `writer`
// is already cryptographically trustworthy by the time this checks it.
export function createACLPlugin(getACL) {
  return async (ctx, next) => {
    const q = ctx.qubit;
    const acl = await getACL(q.id);
    if (!acl || !acl.writers || acl.writers.includes('*')) return next();
    if (!q.writer || !acl.writers.includes(q.writer)) {
      throw new Error(`[ACL] Write denied for ${q.writer ?? 'anonymous'} on ${q.id}`);
    }
    await next();
  };
}

// Read-time ACL is deliberately NOT hidden inside QuStore/Runtime — the old
// draft's relay dumped its entire store to every new socket because nothing
// forced a filter at the sync boundary. This is exported as an explicit
// function that any transport/relay component must call before replaying
// stored qubits to a peer.
//
// ACLs are bound to Spaces (see modules/spaces.js), not individual QuBits,
// so this batches by Space: one getACL() call per distinct Space in the
// batch, not one per QuBit. For a sync response full of many messages from
// the same chat room, that's one manifest lookup instead of hundreds.
export async function filterForReader(qubits, readerFingerprint, getACL) {
  const bySpace = new Map();
  for (const q of qubits) {
    const space = spaceIdOf(q.id);
    if (!bySpace.has(space)) bySpace.set(space, []);
    bySpace.get(space).push(q);
  }

  const out = [];
  for (const [space, group] of bySpace) {
    const acl = await getACL(group[0].id);
    if (!acl || !acl.readers || acl.readers.includes('*') || acl.readers.includes(readerFingerprint)) {
      out.push(...group);
    }
  }
  return out;
}
