import { authenticateChannel } from '../handshake.js';
import { DefaultReplication } from './default.js';
import { DefaultFileTransfer } from '../../data/files/transfer.js';

/**
 * A server node has one Runtime and many Channels (one per connected
 * client) — this is the explicit coordinator for it. attach() proves the
 * peer's identity via authenticateChannel() BEFORE creating anything for
 * that channel, so `peerFingerprint` passed downstream is always a proven
 * value, never an assumption.
 *
 * When constructed with `fileStorage`, the Hub ALSO manages a
 * DefaultFileTransfer per channel, sharing the exact same proven
 * `peerFingerprint` and `getACL` that Replication uses (§13, no separate
 * trust path for files) — one attach() call, one lifecycle, one place a
 * relay wires up "what this connection is allowed to do", instead of
 * assembling Replication and Files as two independently-tracked systems
 * with their own connection bookkeeping. Files remains independently
 * usable without this Hub (DefaultFileTransfer only ever needed a Channel
 * + FileStorageAdapter) — this is a convenience composition, not a new
 * dependency from the Replication module onto the Files module's
 * internals.
 *
 * `requireDirectWriter`/`rateLimiter`/`ingestGate` are opt-in incoming-push
 * protections, applied identically to every channel this Hub attaches —
 * see DefaultReplication's own doc comment (and network/ingest-gate.js) for
 * what each does. Off/empty by default, same as there.
 */
export class ReplicationHub {
  #runtime;
  #getACL;
  #pushTopics;
  #identity;
  #fileStorage;
  #repls = new Map();      // channel.id -> DefaultReplication
  #transfers = new Map();  // channel.id -> DefaultFileTransfer
  #byFingerprint = new Map(); // fingerprint -> channel.id (last-attached wins for a given fingerprint)
  #requireDirectWriter;
  #rateLimiter;
  #ingestGate;

  constructor(runtime, { identity = null, getACL = async () => null, pushTopics = [], fileStorage = null, requireDirectWriter = false, rateLimiter = null, ingestGate = [] } = {}) {
    this.#runtime = runtime;
    this.#identity = identity;
    this.#getACL = getACL;
    this.#pushTopics = pushTopics;
    this.#fileStorage = fileStorage;
    this.#requireDirectWriter = requireDirectWriter;
    this.#rateLimiter = rateLimiter;
    this.#ingestGate = ingestGate;
  }

  async attach(channel) {
    const peerFingerprint = await authenticateChannel(channel, this.#identity);
    const repl = new DefaultReplication(this.#runtime, channel, {
      getACL: this.#getACL,
      peerFingerprint,
      pushTopics: this.#pushTopics,
      requireDirectWriter: this.#requireDirectWriter,
      rateLimiter: this.#rateLimiter,
      ingestGate: this.#ingestGate,
    });
    this.#repls.set(channel.id, repl);

    let fileTransfer = null;
    if (this.#fileStorage) {
      fileTransfer = new DefaultFileTransfer(this.#runtime, channel, this.#fileStorage, {
        getACL: this.#getACL,
        peerFingerprint,
      });
      this.#transfers.set(channel.id, fileTransfer);
    }

    if (peerFingerprint) this.#byFingerprint.set(peerFingerprint, channel.id);
    channel.onClose(() => this.detach(channel.id));
    return { repl, fileTransfer, peerFingerprint };
  }

  detach(channelId) {
    const repl = this.#repls.get(channelId);
    if (repl) { repl.close(); this.#repls.delete(channelId); }
    const xfer = this.#transfers.get(channelId);
    if (xfer) { xfer.close(); this.#transfers.delete(channelId); }
    for (const [fp, id] of this.#byFingerprint) if (id === channelId) this.#byFingerprint.delete(fp);
  }

  get(channelId) { return { repl: this.#repls.get(channelId), fileTransfer: this.#transfers.get(channelId) }; }

  /** The currently-connected channel for a given proven fingerprint, if any — e.g. "ask this specific uploader for their file's chunks". */
  getByFingerprint(fingerprint) {
    const channelId = this.#byFingerprint.get(fingerprint);
    return channelId ? this.get(channelId) : null;
  }

  get size() { return this.#repls.size; }

  async broadcastSync({ topic }) {
    const results = [];
    for (const repl of this.#repls.values()) results.push(repl.sync({ topic }));
    return Promise.all(results);
  }
}
