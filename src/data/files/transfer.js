import { assertChannel } from '../../core/channel.js';
import { sha256Hex, toB64, fromB64 } from '../../core/bytes.js';
import { missingChunks, WRITE_BATCH_SIZE } from './manifest.js';
import { filterForReader } from '../../core/acl.js';
import { debug } from '../../core/debug.js';
import { assertFileStorageAdapter } from './contract.js';

/**
 * File-Handling is an optional Module, same standing as Replication — it
 * only uses Runtime + Channel + its own FileStorageAdapter, no Core change.
 *
 * The manifest is fetched (if not already locally known, e.g. via
 * Replication already having synced it) and run through the normal
 * `runtime.ingest()` — verify + Space-ACL apply to a FileManifest exactly
 * like to any other QuBit. There is no separate trust path for files.
 *
 * Read-ACL applies to *serving* a manifest or a chunk, not just to
 * ingesting one — the same `filterForReader()` used by Replication (§9),
 * not a parallel check invented for files. A chunk request always carries
 * the `manifestId` it belongs to; serving it requires both (a) that
 * manifest's read-ACL to actually allow the requesting peer, and (b) that
 * the requested hash genuinely appears in that manifest's own chunk list
 * (so a peer can't launder access to an unrelated hash by naming a
 * manifest they're allowed to read but that doesn't actually reference
 * it). No per-connection state to track, no separate index to maintain —
 * both checks are cheap lookups against data already on hand.
 *
 * Each chunk is independently content-addressed: a received chunk is
 * hashed and compared against the hash that was actually requested before
 * being stored. A chunk that doesn't hash to what was asked for is
 * rejected outright — this is what lets a single small signature on the
 * manifest transitively protect an arbitrarily large file without signing
 * every chunk individually.
 *
 * Resuming after a dropped connection is just requestFile() again: it
 * diffs against whatever chunks are already in FileStorageAdapter and only
 * asks for what's still missing — same "Store is the queue" idea as
 * Replication (§10), applied at chunk granularity.
 */
export class DefaultFileTransfer {
  #runtime;
  #channel;
  #fileStorage;
  #getACL;
  #peerFingerprint;
  #pending = new Map();
  #reqId = 0;
  #off;

  constructor(runtime, channel, fileStorage, { getACL = async () => null, peerFingerprint = null } = {}) {
    this.#runtime = runtime;
    this.#channel = assertChannel(channel);
    this.#fileStorage = assertFileStorageAdapter(fileStorage);
    this.#getACL = getACL;
    this.#peerFingerprint = peerFingerprint;
    this.#off = channel.onMessage((msg) => this.#handleMessage(msg));
  }

  async #isManifestVisible(qubit) {
    if (!qubit) return false;
    const [visible] = await filterForReader([qubit], this.#peerFingerprint, this.#getACL);
    return !!visible;
  }

  async #handleMessage(msg) {
    if (msg.type === 'qu.file.manifest.request') {
      const qubit = await this.#runtime.get(msg.manifestId);
      const visible = await this.#isManifestVisible(qubit);
      debug('files', 'manifest-request', { manifestId: msg.manifestId, found: !!qubit, visible });
      await this.#channel.send({ type: 'qu.file.manifest.response', reqId: msg.reqId, qubit: visible ? qubit : null });
      return;
    }
    if (msg.type === 'qu.file.chunk.request') {
      const manifestQ = await this.#runtime.get(msg.manifestId);
      const belongsToManifest = manifestQ?.value?.chunks?.includes(msg.hash);
      const allowed = belongsToManifest && (await this.#isManifestVisible(manifestQ));
      const bytes = allowed && (await this.#fileStorage.hasChunk(msg.hash)) ? await this.#fileStorage.getChunk(msg.hash) : null;
      debug('files', 'chunk-request', { manifestId: msg.manifestId, hash: msg.hash, allowed, have: !!bytes });
      await this.#channel.send({ type: 'qu.file.chunk.response', reqId: msg.reqId, hash: msg.hash, bytes: bytes ? toB64(bytes) : null });
      return;
    }
    if (msg.type === 'qu.file.readiness.request') {
      // Same idea as a chunk request, minus the actual bytes — lets a
      // receiver ask "is this fully downloadable yet?" (e.g. right after
      // the relay started mirroring a large file) without spending any
      // transfer bandwidth on the check itself.
      //
      // `have`/`total` (chunk counts, not just the boolean `ready`) let a
      // caller show real "x/y chunks synced" progress instead of a single
      // "not ready yet" — deliberately counted here (not derived from
      // `ready` alone), so a caller never needs a SEPARATE round trip just
      // to learn how far along an in-progress mirror actually is. Both
      // fields are optional/additive on the wire — an older peer that only
      // reads `ready` keeps working unchanged.
      const manifestQ = await this.#runtime.get(msg.manifestId);
      const visible = await this.#isManifestVisible(manifestQ);
      let ready = false;
      let have = 0;
      let total = 0;
      if (visible && manifestQ) {
        total = manifestQ.value.chunks.length;
        for (const hash of manifestQ.value.chunks) {
          if (await this.#fileStorage.hasChunk(hash)) have++;
        }
        ready = have === total;
      }
      debug('files', 'readiness-request', { manifestId: msg.manifestId, visible, ready, have, total });
      await this.#channel.send({ type: 'qu.file.readiness.response', reqId: msg.reqId, ready, have, total });
      return;
    }
    const resolver = this.#pending.get(msg.reqId);
    if (resolver && (msg.type === 'qu.file.manifest.response' || msg.type === 'qu.file.chunk.response' || msg.type === 'qu.file.readiness.response')) {
      this.#pending.delete(msg.reqId);
      resolver(msg);
    }
  }

  async #request(message, timeoutMs = 10000) {
    const reqId = ++this.#reqId;
    const p = new Promise((resolve, reject) => {
      this.#pending.set(reqId, resolve);
      setTimeout(() => { if (this.#pending.has(reqId)) { this.#pending.delete(reqId); reject(new Error('[DefaultFileTransfer] request timed out')); } }, timeoutMs);
    });
    await this.#channel.send({ ...message, reqId });
    return p;
  }

  async #ensureManifest(manifestId) {
    let qubit = await this.#runtime.get(manifestId);
    if (qubit) return qubit;
    const resp = await this.#request({ type: 'qu.file.manifest.request', manifestId });
    if (!resp.qubit) throw new Error(`[DefaultFileTransfer] Peer has no manifest for ${manifestId}, or denied it`);
    await this.#runtime.ingest(resp.qubit); // same verify/ACL pipeline as everything else — no shortcut for files
    return this.#runtime.get(manifestId);
  }

  /**
   * `concurrency` (default 6): how many chunk requests may be in flight at
   * once. Chunk fetching used to be strictly sequential — one request,
   * fully awaited, before the next — which made a large file's download
   * time scale with round-trip latency × chunk count rather than with
   * bandwidth: at 64 KiB/chunk, a 200 MB file is ~3200 chunks, and even at
   * a modest 20-50ms RTT that's over a minute spent purely serialized on
   * one socket, before a single byte's worth of actual bandwidth became
   * the bottleneck. A sliding window of concurrent requests overlaps that
   * latency instead of paying it once per chunk.
   */
  async requestFile(manifestId, { onProgress, concurrency = 6 } = {}) {
    const qubit = await this.#ensureManifest(manifestId);
    const manifest = qubit.value;
    // De-duplicated: content-addressing means the SAME hash can legitimately
    // appear at more than one position in `manifest.chunks` (two identical
    // 64 KiB blocks anywhere in the file, or the same file shared twice) —
    // missingChunks() reports one entry per POSITION, not per unique hash.
    // Fetching a hash more than once wastes bandwidth on the sequential
    // path (harmless, just wasteful) but, worse, on the CONCURRENT path
    // below turns into several simultaneous requests for the byte-for-byte
    // identical content — pointless, and under real contention (a slow
    // IndexedDB lookup answering N identical requests at once) it can
    // starve other genuinely-still-missing chunks past their timeout for
    // no reason. Chunks are stored keyed by hash, not by position, so
    // fetching each unique hash exactly once is enough — every position
    // that shares it already resolves correctly via getChunk(hash) at
    // reassembly time.
    const missing = [...new Set(await missingChunks(this.#fileStorage, manifest))];
    debug('files', 'request-file', { manifestId, totalChunks: manifest.chunks.length, missing: missing.length });
    const maxAttempts = 6; // ~ up to 500+1000+2000+3000+4000ms of backoff — enough for a relay to finish mirroring a moderate file

    // Storage writes go through putChunks() (a batch of WRITE_BATCH_SIZE)
    // if the adapter offers it, else fall back to one putChunk() per
    // chunk — mirrors manifest.js's publishFile() doing exactly this on
    // the SEND side; this is the same fix applied to the RECEIVE side,
    // which previously paid one IndexedDB transaction per chunk (~3200
    // for a 200 MB file) regardless of what the send side already did.
    // `flushChain` serializes the actual writes: several concurrent
    // workers (see `concurrency` above) can each fill a batch around the
    // same moment, and calling putChunks() on the same adapter from two
    // still-in-flight calls at once isn't something every adapter is
    // guaranteed to handle safely — chaining makes each flush wait for
    // the previous one instead.
    const supportsBatch = typeof this.#fileStorage.putChunks === 'function';
    let writeBatch = [];
    let flushChain = Promise.resolve();
    const flush = (batch) => { flushChain = flushChain.then(() => this.#fileStorage.putChunks(batch)); return flushChain; };
    const storeChunk = async (hash, bytes) => {
      if (!supportsBatch) { await this.#fileStorage.putChunk(hash, bytes); return; }
      writeBatch.push({ hash, bytes });
      if (writeBatch.length >= WRITE_BATCH_SIZE) {
        const batch = writeBatch;
        writeBatch = [];
        await flush(batch);
      }
    };

    const fetchOneChunk = async (hash) => {
      let resp = null;
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          resp = await this.#request({ type: 'qu.file.chunk.request', hash, manifestId });
          lastError = null;
        } catch (e) {
          lastError = e;
          resp = null;
        }
        if (resp?.bytes) break;
        // Either the request itself failed, or the peer answered "I don't
        // have it (yet)" — indistinguishable from here, and both are worth
        // retrying: the relay may simply still be mirroring this file from
        // the original uploader when a receiver clicks "download" too soon.
        debug('files', 'chunk-not-ready', { manifestId, hash, attempt, maxAttempts, error: lastError?.message });
        onProgress?.({ attempt, maxAttempts, hash });
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 400 * attempt));
      }
      if (!resp?.bytes) {
        throw new Error(`[DefaultFileTransfer] Chunk ${hash} still unavailable after ${maxAttempts} attempts — the sender may still be uploading, may have disconnected before finishing, or access was denied.`);
      }
      const bytes = fromB64(resp.bytes);
      const actualHash = await sha256Hex(bytes);
      if (actualHash !== hash) {
        debug('files', 'chunk-integrity-failed', { manifestId, hash });
        throw new Error(`[DefaultFileTransfer] Chunk hash mismatch for ${hash} — rejected, not stored`);
      }
      await storeChunk(hash, bytes);
    };

    // Sliding window: `concurrency` workers each pull the next not-yet-
    // claimed hash off `missing` until it's exhausted or one of them
    // fails. The FIRST error wins and is what requestFile() ultimately
    // throws — once one is caught, no NEW fetch is started, but whatever
    // was already in flight is allowed to finish (there's no cheap way to
    // cancel an outstanding #request() mid-flight over this Channel
    // contract, and letting a couple of already-sent requests complete
    // harmlessly is far simpler than adding cancellation just to save
    // that little — their bytes are still valid and get stored either way).
    let nextIndex = 0;
    let firstError = null;
    const worker = async () => {
      while (nextIndex < missing.length && !firstError) {
        const hash = missing[nextIndex++];
        try {
          await fetchOneChunk(hash);
        } catch (e) {
          if (!firstError) firstError = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker));

    // Flush whatever's left in the batch even on failure — those chunks
    // were genuinely verified and downloaded before the failing one; no
    // reason to discard real progress just because a later chunk failed
    // (a retried requestFile() call only re-fetches what's still missing).
    if (writeBatch.length) await flush(writeBatch);

    if (firstError) throw firstError;
    debug('files', 'request-file-complete', { manifestId });
  }

  /**
   * Polls "do you have every chunk yet?" without downloading anything —
   * meant to run *before* requestFile(), so a UI can hold off offering (or
   * silently prepare) a download until it will actually succeed, instead
   * of a receiver clicking too early and requestFile() having to retry its
   * way through a real, if temporary, failure.
   */
  async waitUntilReady(manifestId, { intervalMs = 1000, maxWaitMs = 30000, onProgress } = {}) {
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < maxWaitMs) {
      attempt++;
      let ready = false;
      let have = 0;
      let total = 0;
      try {
        const resp = await this.#request({ type: 'qu.file.readiness.request', manifestId });
        ready = !!resp.ready;
        have = resp.have ?? 0;
        total = resp.total ?? 0;
      } catch (e) {
        debug('files', 'readiness-check-failed', { manifestId, attempt, error: e.message });
      }
      if (ready) { debug('files', 'ready', { manifestId, attempt }); return true; }
      // `have`/`total` — real "x/y Chunks" progress for a UI, not just
      // "still waiting" (see qu.file.readiness.response's own doc above).
      // Both 0 on a failed/errored request attempt itself, not on a
      // legitimate "0 of N chunks synced yet" — a caller can't tell those
      // apart from this shape alone, which is fine: both render the same
      // "no progress to show yet" either way.
      onProgress?.({ attempt, elapsedMs: Date.now() - start, have, total });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return false;
  }

  async hasComplete(manifestId) {
    const qubit = await this.#runtime.get(manifestId);
    if (!qubit) return false;
    const missing = await missingChunks(this.#fileStorage, qubit.value);
    return missing.length === 0;
  }

  close() { this.#off(); }
}
