import { assertChannel } from '../../core/channel.js';
import { sha256Hex, toB64, fromB64 } from '../../core/bytes.js';
import { missingChunks } from './manifest.js';
import { filterForReader } from '../../core/acl.js';
import { debug } from '../../core/debug.js';

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
    this.#fileStorage = fileStorage;
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
      const manifestQ = await this.#runtime.get(msg.manifestId);
      const visible = await this.#isManifestVisible(manifestQ);
      let ready = false;
      if (visible && manifestQ) {
        ready = true;
        for (const hash of manifestQ.value.chunks) {
          if (!(await this.#fileStorage.hasChunk(hash))) { ready = false; break; }
        }
      }
      debug('files', 'readiness-request', { manifestId: msg.manifestId, visible, ready });
      await this.#channel.send({ type: 'qu.file.readiness.response', reqId: msg.reqId, ready });
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

  async requestFile(manifestId, { onProgress } = {}) {
    const qubit = await this.#ensureManifest(manifestId);
    const manifest = qubit.value;
    const missing = await missingChunks(this.#fileStorage, manifest);
    debug('files', 'request-file', { manifestId, totalChunks: manifest.chunks.length, missing: missing.length });
    const maxAttempts = 6; // ~ up to 500+1000+2000+3000+4000ms of backoff — enough for a relay to finish mirroring a moderate file
    for (const hash of missing) {
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
      await this.#fileStorage.putChunk(hash, bytes);
    }
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
      try {
        const resp = await this.#request({ type: 'qu.file.readiness.request', manifestId });
        ready = !!resp.ready;
      } catch (e) {
        debug('files', 'readiness-check-failed', { manifestId, attempt, error: e.message });
      }
      if (ready) { debug('files', 'ready', { manifestId, attempt }); return true; }
      onProgress?.({ attempt, elapsedMs: Date.now() - start });
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
