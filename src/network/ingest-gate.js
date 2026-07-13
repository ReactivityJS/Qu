// Reusable incoming-push validation building blocks — the same
// `(ctx, next) => Promise<void>` middleware shape core/pipeline.js's
// QuPipeline already uses for Runtime.ingest()'s Verify/ACL commit
// pipeline, applied here to a different ctx (`{ qubit, peerFingerprint,
// channelId }` for one incoming `qu.push` on one specific connection,
// BEFORE it's ever handed to runtime.ingest()). DefaultReplication
// assembles these — plus whatever a caller passes via its own `ingestGate`
// option — into one QuPipeline (see replication/default.js), instead of
// every new protection growing another hard-coded constructor flag + a
// dedicated if-check in #handleMessage(). requireDirectWriter/rateLimiter
// stay available as their own shorthand options too (no API break) — this
// is what they build on under the hood.
//
// A gate middleware THROWS to reject, same convention as core/acl.js's
// createACLPlugin — DefaultReplication catches it, logs via debug(), and
// silently drops the push, exactly like an ACL-rejected write.

export function requireDirectWriterGate() {
  return async (ctx, next) => {
    if (ctx.qubit?.writer !== ctx.peerFingerprint) {
      throw new Error(`[IngestGate] push rejected: writer "${ctx.qubit?.writer}" is not this connection's own proven fingerprint "${ctx.peerFingerprint}" (requireDirectWriter)`);
    }
    return next();
  };
}

export function rateLimitGate(rateLimiter) {
  return async (ctx, next) => {
    const key = ctx.qubit?.writer ?? ctx.peerFingerprint ?? ctx.channelId;
    if (!rateLimiter.allow(key)) {
      throw new Error(`[IngestGate] push rejected: rate limit exceeded for "${key}"`);
    }
    return next();
  };
}
