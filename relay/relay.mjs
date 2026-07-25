import { Qu, QuStore, MemoryAdapter, NullAdapter, ReplicationHub, createSpacesPlugin, createSpaceACLResolver, DefaultFileTransfer, MemoryFileStorageAdapter } from '../src/index.js';
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
  // A caller who enables this should also mount `push-subscription/` on a
  // NullAdapter with `{ replicate: false }` in whatever `store` it passes
  // above (see index.js) — a client registers a subscription by publishing
  // an ordinary signed QuBit to `push-subscription/<fp>` (examples/chat/
  // app.mjs), and that mount is what keeps it ephemeral (processed live,
  // never persisted as a queryable QuBit, never forwarded to another
  // peer) instead of accumulating forever like a normal Space. Without
  // that mount the write still works, it just falls through to whatever
  // the DEFAULT mount does with it (typically: persisted like anything
  // else) — a degraded but harmless fallback, not a crash.
  sendPush = null,
  pushSubscriptions = new Map(),
} = {}) {
  const relay = (await Qu.create({ store, identity })).use(createSpacesPlugin()); // generic (non-User) rooms — the relay's own Runtime enforces this on every incoming push, exactly like any other write

  // `push-subscription/<fp>` (see the sendPush hook below): the same
  // structural argument core/identity-acl.js already makes for
  // `~<fp>/**` ("only you can ever produce a valid signature for
  // `writer = <your fingerprint>`"), just applied to a flat id shape
  // instead of a User-Space one — a flat shape is what lets `store`
  // mount exactly this one prefix on a NullAdapter (see doc comment
  // above) without touching any other id. Falls through to a FRESH
  // Spaces resolver for everything else, completely unchanged — this
  // must be a new createSpaceACLResolver() call, not `relay.acl`: that
  // getter always re-reads whatever resolver is CURRENTLY installed
  // (its whole point, see qu.js), so capturing it as a "base" BEFORE
  // calling setACLResolver() below would only alias back to this very
  // wrapper once installed, recursing into itself forever.
  const spacesACL = createSpaceACLResolver(relay.runtime);
  relay.setACLResolver(async (id) => {
    const m = /^push-subscription\/([0-9a-f]{24})$/i.exec(id);
    return m ? { writers: [m[1]], readers: ['*'] } : spacesACL(id);
  });

  const hub = new ReplicationHub(relay.runtime, {
    identity: relay.identity, getACL: relay.acl, pushTopics, requireDirectWriter, rateLimiter, ingestGate,
    allowDynamicSubscribe, maxDynamicTopics,
  });
  const connected = new Map(); // fingerprint -> { channel, fileTransfer }
  const recentCallPushes = new Map(); // to-fingerprint -> timestamp of the last call-invite push sent them
  const CALL_PUSH_COOLDOWN_MS = 20_000; // examples/chat/app.mjs's startCall() re-announces 'call-invite' every 6s while ringing — without this, one ring would trigger a push every 6s instead of once

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

    // A push subscription is registered through the SAME publish/dispatch
    // path as any other write (`qu.session.publish('push-subscription/'
    // + fp, subscription)`, see examples/chat/app.mjs) — no bespoke
    // channel-message type. Two things make this the right shape rather
    // than reinventing a signaling mechanism the framework already has
    // (core/routed-events.js's `qu.route`, NullAdapter's own doc comment
    // on "Presence-Pings, Tippindikatoren etc." going through this exact
    // pipeline):
    //   - Write ACL below restricts `push-subscription/<fp>` to `<fp>`
    //     alone, the same structural "only you can ever sign as you"
    //     argument core/identity-acl.js already makes for `~<fp>/**` —
    //     nobody else can register or overwrite your subscription.
    //   - The id is expected to be mounted on a NullAdapter (see this
    //     function's own doc comment on `store`) with `replicate: false`
    //     — the write still runs the full verify+ACL+dispatch pipeline
    //     (this listener fires normally), but nothing is ever persisted
    //     as a queryable QuBit and nothing is ever forwarded to another
    //     peer (network/replication/default.js's isReplicable() check).
    //     Durability across a relay restart is `pushSubscriptions`s own
    //     job (a caller-provided, e.g. disk-backed, Map — see index.js),
    //     deliberately separate from "is this a QuBit anyone can read
    //     back later", which for an endpoint+keys blob it structurally
    //     should never be.
    relay.runtime.on('push-subscription/*', (q) => {
      if (q.ephemeral || !q.writer) return;
      const fp = q.id.slice('push-subscription/'.length);
      if (fp !== q.writer) return; // ACL below already rejects this at ingest; a redundant local check costs nothing
      if (q.value == null) { pushSubscriptions.delete(fp); debug('relay', 'push-unsubscribed', { fingerprint: fp }); }
      else { pushSubscriptions.set(fp, q.value); debug('relay', 'push-subscribed', { fingerprint: fp }); }
    });
  }

  // Proactively mirror a file's chunks from its uploader while they're
  // still connected — this is what lets a *different* client download it
  // later even after the uploader is gone. Pattern matches any single
  // space segment followed by "files/...", not tied to any specific app's
  // room-naming scheme.
  //
  // This is a ONE-SHOT attempt, triggered once at ingest time — which is
  // exactly the gap this `pendingMirrors` bookkeeping closes: a real
  // upload (a phone photo/video over a flaky mobile connection) can take
  // long enough that the uploader disconnects mid-mirror, or hasn't even
  // reconnected yet when their own file manifest QuBit arrives via a
  // LATER sync from elsewhere. Without retrying, that file is stuck
  // forever — a receiver's own requestFile() retries (data/files/
  // transfer.js) are retrying against a relay that never actually got
  // the chunks, so they can only ever fail the same way, repeatedly.
  // `pendingMirrors` remembers which file ids from which uploader still
  // need mirroring; attachChannel() below retries them the moment that
  // uploader's fingerprint reconnects — no polling, no fixed retry
  // schedule, just "try again the next time we plausibly can."
  const pendingMirrors = new Map(); // fingerprint -> Set<qubit id>
  const MAX_PENDING_MIRRORS_PER_UPLOADER = 200; // bounded, same reasoning as maxDynamicTopics above — one uploader shouldn't be able to grow this forever
  // Welche ids GERADE laufen — ein großer Anhang kann länger brauchen, als
  // der periodische Sweep unten auseinander liegt (20s); ohne diese Sperre
  // würde der Sweep für eine noch laufende id einen zweiten, redundanten
  // requestFile()-Durchlauf parallel lostreten (dieselbe Absicherung wie
  // examples/chat/app.mjs's confirmInFlight, hier serverseitig).
  const mirrorInFlight = new Set();

  async function mirrorFile(id, writer, fileTransfer) {
    if (mirrorInFlight.has(id)) return;
    mirrorInFlight.add(id);
    debug('relay', 'mirror-start', { id, writer });
    try {
      await fileTransfer.requestFile(id);
      pendingMirrors.get(writer)?.delete(id);
      debug('relay', 'mirror-complete', { id });
    } catch (e) {
      let pending = pendingMirrors.get(writer);
      if (!pending) { pending = new Set(); pendingMirrors.set(writer, pending); }
      if (pending.size < MAX_PENDING_MIRRORS_PER_UPLOADER) pending.add(id);
      debug('relay', 'mirror-failed', { id, error: e.message });
      console.error(`[Relay] failed to mirror ${id}:`, e.message);
    } finally {
      mirrorInFlight.delete(id);
    }
  }

  relay.runtime.on('*/files/**', (q) => {
    if (q.ephemeral || !q.writer) return;
    const uploader = connected.get(q.writer);
    if (!uploader) {
      debug('relay', 'mirror-skip-uploader-offline', { id: q.id, writer: q.writer });
      let pending = pendingMirrors.get(q.writer);
      if (!pending) { pending = new Set(); pendingMirrors.set(q.writer, pending); }
      if (pending.size < MAX_PENDING_MIRRORS_PER_UPLOADER) pending.add(q.id);
      return;
    }
    mirrorFile(q.id, q.writer, uploader.fileTransfer);
  });

  // Periodischer Sicherheitsnetz-Sweep, dieselbe Lücke wie examples/chat/
  // app.mjs's eigener confirmDelivery()-Sweep, nur serverseitig: attachChannel()
  // unten retried pendingMirrors NUR bei einem NEUEN Verbindungsaufbau —
  // scheitert mirrorFile() dagegen, WÄHREND der Uploader durchgehend
  // verbunden bleibt (ein einzelner Chunk-Request timet aus, der Browser-
  // Tab hängt kurz durch etc.), bleibt die id in pendingMirrors stehen und
  // NICHTS versucht es je wieder — kein Reconnect-Event fällt an, das den
  // Retry auslösen könnte. Dieses Intervall schließt genau diese Lücke:
  // JEDE noch offene id wird erneut versucht, sooft ihr Uploader gerade
  // verbunden ist, unabhängig von Reconnects. `.unref()` (nur in Node
  // vorhanden, siehe createRelay()'s eigene Doku zu "läuft auch im
  // Browser") — ein Timer, der den Prozess künstlich am Leben hält, ist
  // genau der Fehler, der die CI vorher stundenlang hängen ließ (siehe
  // Commit zu Node-20/WebSocket); ein Relay-Prozess soll natürlich am
  // Leben bleiben, aber nicht DESHALB.
  const mirrorRetryTimer = setInterval(() => {
    for (const [fp, ids] of pendingMirrors) {
      if (!ids.size) continue;
      const uploader = connected.get(fp);
      if (!uploader) continue;
      for (const id of [...ids]) mirrorFile(id, fp, uploader.fileTransfer);
    }
  }, 20000);
  if (typeof mirrorRetryTimer.unref === 'function') mirrorRetryTimer.unref();

  /** Authenticates and attaches one Channel. Returns its proven peerFingerprint (or null if anonymous) and its per-connection DefaultFileTransfer. */
  async function attachChannel(channel) {
    const { peerFingerprint } = await hub.attach(channel);
    debug('relay', 'channel-attached', { channelId: channel.id, peerFingerprint });
    const fileTransfer = new DefaultFileTransfer(relay.runtime, channel, fileStorage);
    if (peerFingerprint) connected.set(peerFingerprint, { channel, fileTransfer });

    // Retry any of THIS fingerprint's uploads the proactive mirror above
    // couldn't finish earlier (they were offline, or the attempt failed
    // mid-transfer) — see pendingMirrors' doc comment. Iterated as a copy
    // (`[...pending]`) since mirrorFile() mutates the same Set it's
    // iterating (deletes on success).
    const pendingForThisUploader = peerFingerprint ? pendingMirrors.get(peerFingerprint) : null;
    if (pendingForThisUploader?.size) {
      debug('relay', 'mirror-retry-on-reconnect', { fingerprint: peerFingerprint, count: pendingForThisUploader.size });
      for (const id of [...pendingForThisUploader]) mirrorFile(id, peerFingerprint, fileTransfer);
    }

    // Generisches, geroutetes, ephemeres Event nach Fingerprint — dritte
    // Kategorie neben gespeicherten Daten (publish/append) und lokalen
    // Events (runtime.emit), siehe core/routed-events.js. Der Relay
    // interpretiert `payload`/`event` nie, genauso wenig wie er den `value`
    // eines QuBits interpretiert — er kennt nur `to`. Kein Broadcast: nur
    // der eine adressierte, verbundene Fingerprint bekommt die Nachricht.
    const offSignaling = channel.onMessage((msg) => {
      if (msg?.type !== 'qu.route' || !msg.to) return;
      // `kind`/`sdpType` NUR fürs Log ausgelesen (webrtc-signal-spezifisch,
      // s. src/network/transports/webrtc-browser.js) — der Relay
      // interpretiert `payload` sonst nirgends, das bleibt so; hilft aber
      // beim Debuggen enorm zu sehen, ob z. B. ein Offer/Answer/ICE-
      // Kandidat überhaupt beim Relay ankommt und weitergeleitet wird,
      // getrennt davon, ob die eigentliche P2P-Verbindung danach klappt.
      const kind = msg.event === 'webrtc-signal' ? msg.payload?.kind : undefined;
      const sdpType = kind === 'sdp' ? msg.payload?.data?.type : undefined;
      debug('relay', 'route-received', { to: msg.to, from: peerFingerprint, event: msg.event, kind, sdpType });
      const target = connected.get(msg.to);
      if (!target) {
        debug('relay', 'route-target-offline', { to: msg.to, from: peerFingerprint, event: msg.event });
        // Ein Anruf-Klingeln (examples/chat/app.mjs's startCall(), 'call-
        // invite') ist der einzige geroutete Event-Typ, für den "die
        // Gegenseite bekommt es sonst NIE" tatsächlich ein Problem ist —
        // anders als z. B. ein ICE-Kandidat (der ohnehin nur Sinn ergibt,
        // während schon eine laufende Verbindung ausgehandelt wird) lohnt
        // sich hier ein Weckruf: dieselbe Web-Push-Infrastruktur wie beim
        // Nachrichten-Hook oben, nur mit anderem Titel/Text und OHNE
        // jeglichen Anruf-Inhalt (SDP/ICE bleiben weiterhin ungepuffert
        // verloren — der Push weckt nur das Gerät/die App; startCall()
        // klingelt periodisch erneut an, solange noch geklingelt wird,
        // genau damit ein rechtzeitig reconnectender Angerufener den
        // Anruf tatsächlich noch bekommt, siehe dortige Doku).
        if (sendPush && msg.event === 'call-invite') {
          const subscription = pushSubscriptions.get(msg.to);
          const lastPush = recentCallPushes.get(msg.to) ?? 0;
          if (subscription && Date.now() - lastPush >= CALL_PUSH_COOLDOWN_MS) {
            recentCallPushes.set(msg.to, Date.now());
            relay.runtime.get(`~${peerFingerprint}/alias`).then((aliasQ) => {
              const callerName = aliasQ?.value ?? null;
              return sendPush({
                subscription,
                payload: {
                  title: 'QU Chat', call: true, fp: peerFingerprint,
                  body: callerName ? `📞 ${callerName} ruft an` : '📞 Eingehender Anruf',
                },
              });
            }).then(() => {
              debug('relay', 'call-push-sent', { to: msg.to, from: peerFingerprint });
            }).catch((e) => {
              if (e.status === 404 || e.status === 410) pushSubscriptions.delete(msg.to);
              debug('relay', 'call-push-failed', { to: msg.to, from: peerFingerprint, error: e.message, status: e.status });
              console.error(`[Relay] call push to ${msg.to} failed:`, e.message);
            });
          }
        }
        return;
      }
      // `from` kommt aus der eigenen, per Handshake bewiesenen Kenntnis
      // dieser Verbindung — ein eventuell mitgeschicktes `msg.from` wird
      // ignoriert, genau wie bei jedem anderen Schreibpfad hier (kein
      // Vertrauen auf eine Behauptung).
      target.channel.send({ type: 'qu.route', to: msg.to, from: peerFingerprint, event: msg.event, payload: msg.payload }).then(() => {
        debug('relay', 'route-forwarded', { to: msg.to, from: peerFingerprint, event: msg.event, kind, sdpType });
      }).catch((e) => {
        debug('relay', 'route-forward-failed', { to: msg.to, from: peerFingerprint, error: e.message });
      });
    });

    // Push-Subscription-Registrierung braucht hier KEINEN eigenen Handler
    // mehr — sie läuft als ganz normaler, signierter `qu.session.publish()`
    // über genau dieselbe Replication wie jeder andere Write (siehe
    // `push-subscription/<fp>`-ACL und den `relay.runtime.on(...)`-Listener
    // oben in createRelay()).

    channel.onClose(() => {
      debug('relay', 'channel-detached', { channelId: channel.id, peerFingerprint });
      offSignaling();
      fileTransfer.close();
      // NUR löschen, wenn `connected` für diese Fingerprint immer noch
      // GENAU DIESEN Channel führt — nicht blind per Fingerprint. Zwei
      // Verbindungen derselben Identität können sich kurz überlappen (ein
      // Reconnect-Versuch baut schon eine neue Verbindung auf, bevor die
      // alte serverseitig als geschlossen erkannt wurde; zwei offene Tabs
      // derselben Identität sind ein weiterer, dauerhafter Fall). Ohne
      // diesen Vergleich würde das VERSPÄTETE close-Event der alten
      // Verbindung den frischen, noch lebenden Eintrag der neuen
      // Verbindung aus `connected` werfen — mit zwei sichtbaren Folgen:
      // mirrorFile() hält den Uploader danach fälschlich für offline
      // (Datei landet nur noch im pendingMirrors-Fallback statt sofort
      // gespiegelt zu werden), und ein an diese Fingerprint geroutetes
      // qu.route-Ereignis (WebRTC-Signaling, Anruf-Einladung) verpufft
      // ins Leere, obwohl die Gegenseite die ganze Zeit über verbunden war.
      if (peerFingerprint && connected.get(peerFingerprint)?.channel === channel) connected.delete(peerFingerprint);
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
