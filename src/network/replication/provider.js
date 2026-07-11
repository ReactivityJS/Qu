// Replication is a Module, not Core. It is built entirely out of Core
// primitives (Runtime.publish/query/ingest/emit + a Channel) plus the ACL
// read-filter from plugins/acl.js. The Core has no idea Replication exists.
//
// Contract every ReplicationProvider must implement. Swapping
// DefaultReplication for MerkleReplication/BloomReplication/
// EnterpriseReplication means implementing this same shape — the rest of
// the application (and the Core) never changes.
export function assertReplicationProvider(p) {
  for (const m of ['sync', 'repair', 'snapshot', 'listen']) {
    if (typeof p[m] !== 'function') {
      throw new Error(`[ReplicationProvider] Object does not satisfy the contract: missing "${m}"`);
    }
  }
  return p;
}
