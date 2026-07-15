import { Qu, QuStore, MemoryAdapter, NullAdapter, ReplicationHub, createSpacesPlugin, DefaultFileTransfer, MemoryFileStorageAdapter } from '../src/index.js';
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
  // Both opt-in incoming-push protections (network/replication/default.js),
  // applied identically to every connection this relay attaches:
  //   requireDirectWriter — only accept a push whose qubit.writer is the
  //     connection's own proven fingerprint, i.e. a strict star topology
  //     (this relay only ever hears a write from its actual author, never
  //     forwarded/relayed by a third party). Off by default because a
  //     legitimate mesh/gossip topology (e.g. a client relaying what it
  //     learned from a WebRTC peer onward to its own mirror connection)
  //     needs writer !== the connection it arrives on.
  //   rateLimiter — a createRateLimiter() instance (network/rate-limiter.js)
  //     or compatible `{ allow(key) }`, capping how many writes per second
  //     a single fingerprint may push through THIS relay. `null` (default)
  //     leaves the relay unprotected against flooding — pass one in for
  //     anything reachable beyond localhost/trusted clients.
  //   ingestGate — additional `(ctx, next) => Promise<void>` middleware
  //     (network/ingest-gate.js), run after requireDirectWriter/rateLimiter,
  //     for a custom incoming-push policy this relay's own deployment needs
  //     that isn't one of the two built-ins — a fourth protection is a
  //     function passed in here, not a new parameter on this signature.
  requireDirectWriter = false,
  rateLimiter = null,
  ingestGate = [],
  // Runtime topic registration — see network/replication/default.js's
  // constructor doc and README's "Relay App-unabhängig betreiben" section.
  // `false` (default): no client may register a new topic at runtime — the
  // relay only ever pushes what's in `pushTopics` above, exactly as
  // before this option existed. `true`: any connecting client may register
  // any topic via qu.subscribe() — the "unbound relay" case, for a
  // deployment that doesn't want to know app/Space ids in advance. A
  // string array: a hard ceiling, restricting the relay to one or more
  // App-Space id prefixes (a genuine security/scoping decision for a
  // "private App Server", independent of and in addition to the ACL check
  // every push already goes through regardless).
  allowDynamicSubscribe = false,
  maxDynamicTopics = 200,
  // Web Push (relay/webpush.mjs) — entirely optional, off unless a caller
  // supplies BOTH of these:
  //   sendPush({ subscription, payload }) — how to actually deliver one
  //     push message. Injected rather than hard-imported so this file
  //     stays deployment-agnostic (same reasoning as `store`/`fileStorage`
  //     above) — a caller not wired for Web Push pays nothing for it, and
  //     a test can pass a fake to assert on without any real network I/O.
  //   pushSubscriptions — a `Map`-like store (get/set/delete/has) of
  //     fingerprint -> Push API subscription object, caller-owned so
  //     PERSISTENCE (surviving a relay restart, which a subscription must
  //     — see index.js) stays this module's caller's decision, exactly
  //     like `store` above.
  sendPush = null,
  pushSubscriptions = new Map(),
} = {}) {
  const relay = (await Qu.create({ store, identity })).use(createSpacesPlugin()); // generic (non-User) rooms — the relay's own Runtime enforces this on every incoming push, exactly like any other write
  const hub = new ReplicationHub(relay.runtime, {
    identity: relay.identity, getACL: relay.acl, pushTopics, requireDirectWriter, rateLimiter, ingestGate,
    allowDynamicSubscribe, maxDynamicTopics,
  });
  const connected = new Map(); // fingerprint -> { channel, fileTransfer }

  // Notify an OFFLINE room member by Web Push instead of the live delivery
  // they'd otherwise get through their own connection — this is what lets
  // a chat reach someone whose tab/app isn't even open. Matches
  // modules/chat.js's message-id shape exactly (`<roomId>/msgs/<writerFp>-
  // <ts>`, from Session.append()) rather than a generic pattern, so this
  // hook — unlike the file-mirror one above — genuinely is chat-specific;
  // only active at all if a caller opted in via `sendPush` above. No
  // message CONTENT is ever put in a push payload (only ever a generic
  // "you have a new message" + the sender's fingerprint, so the client can
  // deep-link there) — a push service is not a party any of this app's
  // encryption trusts, exactly like the relay itself.
  if (sendPush) {
    relay.runtime.on('*/msgs/*', async (q) => {
      if (q.ephemeral || !q.writer) return;
      const roomId = q.id.slice(0, q.id.indexOf('/msgs/'));
      if (!roomId) return;
      const manifestQ = await relay.runtime.get(roomId);
      const members = manifestQ?.value?.writers ?? [];
      for (const member of members) {
        if (member === q.writer || member === '*' || connected.has(member)) continue;
        const subscription = pushSubscriptions.get(member);
        if (!subscription) continue;
        try {
          const aliasQ = await relay.runtime.get(`~${q.writer}/alias`);
          const senderName = aliasQ?.value ?? null;
          await sendPush({
            subscription,
            payload: { title: 'QU Chat', body: senderName ? `${senderName} hat dir geschrieben` : 'Du hast eine neue Nachricht erhalten', fp: q.writer },
          });
          debug('relay', 'push-sent', { to: member, roomId });
        } catch (e) {
          // A 404/410 means the push service considers this subscription
          // gone (expired/revoked) — drop it so future messages don't keep
          // retrying a dead endpoint; any other failure (network blip,
          // 5xx) is left in place for the next message to retry.
          if (e.status === 404 || e.status === 410) pushSubscriptions.delete(member);
          debug('relay', 'push-failed', { to: member, roomId, error: e.message, status: e.status });
          console.error(`[Relay] push to ${member} failed:`, e.message);
        }
      }
    });
  }

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

    // Push-Subscription-Registrierung — bewusst KEIN QuBit (kein `qu.get()`/
    // `put()`), sondern derselbe schlanke, relay-interne
    // "authentifizierte Verbindung sagt mir etwas über sich selbst"-Weg wie
    // `qu.route` oben: eine Subscription (Push-Endpoint + Schlüssel) ist
    // reines Zustellungs-Bookkeeping, kein Chat-Inhalt, und müsste als
    // QuBit unter `~<fp>/...` sonst denselben (Standard-offenen) Read-ACLs
    // wie `avatar`/`alias` folgen — jede andere verbundene Identität könnte
    // sie lesen und darüber beliebige Push-Nachrichten an dieses Gerät
    // auslösen. Hier bleibt sie ausschließlich dem Relay bekannt, adressiert
    // durch die per Handshake bewiesene `peerFingerprint` dieser Verbindung,
    // kein `to`/`from` aus der Nachricht selbst wird je vertraut.
    const offPush = channel.onMessage((msg) => {
      if (!peerFingerprint) return;
      if (msg?.type === 'qu.push.subscribe' && msg.subscription?.endpoint) {
        pushSubscriptions.set(peerFingerprint, msg.subscription);
        debug('relay', 'push-subscribed', { fingerprint: peerFingerprint });
      } else if (msg?.type === 'qu.push.unsubscribe') {
        pushSubscriptions.delete(peerFingerprint);
        debug('relay', 'push-unsubscribed', { fingerprint: peerFingerprint });
      }
    });

    channel.onClose(() => {
      debug('relay', 'channel-detached', { channelId: channel.id, peerFingerprint });
      offSignaling();
      offPush();
      fileTransfer.close();
      if (peerFingerprint) connected.delete(peerFingerprint);
    });
    return { peerFingerprint, fileTransfer };
  }

  return {
    relay,
    hub,
    fileStorage,
    pushSubscriptions,
    attachChannel,
    get connectedCount() { return connected.size; },
  };
}
