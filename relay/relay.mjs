import { Qu, QuStore, MemoryAdapter, NullAdapter, ReplicationHub, createSpaceACLResolver, DefaultFileTransfer, MemoryFileStorageAdapter } from '../src/index.js';
import { debug } from '../src/core/debug.js';

/**
 * A universal QU relay: one shared Runtime, many Channels attached to it
 * via the existing ReplicationHub, plus proactive file-chunk mirroring.
 * Nothing here is specific to chat, a ticketing app, or any other domain —
 * this is the same "one Runtime, many Channels" Node model the whitepaper
 * already describes (§10/§12), just given a name. Any QU application can
 * mount its own topics/rooms onto it; the relay itself has no opinion
 * about what they mean.
 *
 * How a Channel is obtained is deliberately decoupled from this file. A
 * raw WebSocket connection (see node-ws-bridge.mjs) is one way; a WebRTC
 * DataChannel, or a browser tab acting as a relay for other tabs, would
 * work identically — attachChannel() only needs something that satisfies
 * the Channel contract (core/channel.js), the same one used everywhere
 * else in QU.
 *
 * Storage is fully caller-provided, not assumed. The default (in-memory)
 * runs identically in Node and in a browser — there is no built-in
 * dependency on a filesystem, so this file itself never imports one. A
 * deployment that wants durable mirroring passes in its own StorageAdapter
 * / FileStorageAdapter (e.g. Node's FileSystemStorageAdapter — see
 * node-ws-bridge.mjs's caller for an example) instead of this module
 * deciding that on its own.
 */
export async function createRelay({
  store = new QuStore([
    { prefix: '', adapter: new MemoryAdapter() },
    { prefix: 'signal/', adapter: new NullAdapter() }, // example: routing-only data, see whitepaper §6.2 — never persisted, still dispatched live
  ]),
  fileStorage = new MemoryFileStorageAdapter(),
  identity,
  pushTopics = [],
} = {}) {
  const relay = await Qu.create({ store, identity });
  const acl = createSpaceACLResolver(relay.runtime);
  const hub = new ReplicationHub(relay.runtime, { identity: relay.identity, getACL: acl, pushTopics });
  const connected = new Map(); // fingerprint -> { channel, fileTransfer }

  // Proactively mirror a file's chunks from its uploader while they're
  // still connected — this is what lets a *different* client download it
  // later even after the uploader is gone. Pattern matches any single
  // space segment followed by "files/...", not tied to any specific app's
  // room-naming scheme.
  relay.runtime.on('*/files/**', async (q) => {
    if (q.ephemeral || !q.writer) return;
    const uploader = connected.get(q.writer);
    if (!uploader) {
      debug('relay', 'mirror-skip-uploader-offline', { id: q.id, writer: q.writer });
      return;
    }
    debug('relay', 'mirror-start', { id: q.id, writer: q.writer });
    try {
      await uploader.fileTransfer.requestFile(q.id);
      debug('relay', 'mirror-complete', { id: q.id });
    } catch (e) {
      debug('relay', 'mirror-failed', { id: q.id, error: e.message });
      console.error(`[Relay] failed to mirror ${q.id}:`, e.message);
    }
  });

  /** Authenticates and attaches one Channel. Returns its proven peerFingerprint (or null if anonymous) and its per-connection DefaultFileTransfer. */
  async function attachChannel(channel) {
    const { peerFingerprint } = await hub.attach(channel);
    debug('relay', 'channel-attached', { channelId: channel.id, peerFingerprint });
    const fileTransfer = new DefaultFileTransfer(relay.runtime, channel, fileStorage);
    if (peerFingerprint) connected.set(peerFingerprint, { channel, fileTransfer });

    // Generisches, geroutetes, ephemeres Event nach Fingerprint — dritte
    // Kategorie neben gespeicherten Daten (publish/append) und lokalen
    // Events (runtime.emit), siehe core/routed-events.js. Der Relay
    // interpretiert `payload`/`event` nie, genauso wenig wie er den `value`
    // eines QuBits interpretiert — er kennt nur `to`. Kein Broadcast: nur
    // der eine adressierte, verbundene Fingerprint bekommt die Nachricht.
    const offSignaling = channel.onMessage((msg) => {
      if (msg?.type !== 'qu.route' || !msg.to) return;
      const target = connected.get(msg.to);
      if (!target) {
        debug('relay', 'route-target-offline', { to: msg.to, from: peerFingerprint, event: msg.event });
        return;
      }
      // `from` kommt aus der eigenen, per Handshake bewiesenen Kenntnis
      // dieser Verbindung — ein eventuell mitgeschicktes `msg.from` wird
      // ignoriert, genau wie bei jedem anderen Schreibpfad hier (kein
      // Vertrauen auf eine Behauptung).
      target.channel.send({ type: 'qu.route', to: msg.to, from: peerFingerprint, event: msg.event, payload: msg.payload }).catch((e) => {
        debug('relay', 'route-forward-failed', { to: msg.to, from: peerFingerprint, error: e.message });
      });
    });

    channel.onClose(() => {
      debug('relay', 'channel-detached', { channelId: channel.id, peerFingerprint });
      offSignaling();
      fileTransfer.close();
      if (peerFingerprint) connected.delete(peerFingerprint);
    });
    return { peerFingerprint, fileTransfer };
  }

  return {
    relay,
    hub,
    fileStorage,
    attachChannel,
    get connectedCount() { return connected.size; },
  };
}
