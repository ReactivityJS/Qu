import { Qu, QuStore, MemoryAdapter, NullAdapter, ReplicationHub, createSpacesPlugin, createSpaceACLResolver, DefaultFileTransfer, MemoryFileStorageAdapter } from '../src/index.js';
import { decryptWith } from '../src/core/crypto.js';
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
  // Optional network/connection-gate.js instance (or compatible
  // `{ check({fingerprint, connectedCount}) }`) — caps simultaneously
  // connected fingerprints and/or restricts which fingerprints may connect
  // at all. `null` (default) leaves connections unlimited, exactly as
  // before this option existed. Checked once per Channel, right after
  // authentication (attachChannel() below) — NOT per push, unlike
  // rateLimiter/ingestGate above, which is why it's a separate option
  // rather than another ingestGate entry.
  connectionGate = null,
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
  // WHICH writes actually trigger a push, and to whom — a plain, caller-
  // supplied array of `{ pattern, resolveRecipients(q, runtime), buildPayload(q,
  // senderAlias) }` descriptors, exactly the same "a new behavior is a
  // function/object passed in here, not new code in this file" shape
  // `ingestGate`/`serviceRegistry` already use above. This file deliberately
  // knows NOTHING about "msgs", "events", "Chat", or "Kalender" — every one
  // of those decisions lives in the CONTENT module that actually defines
  // that shape (see modules/chat.js's createChatPushRule(), modules/
  // calendar.js's createCalendarPushRule(), modules/item-invites.js's
  // createItemInvitePushRule()) and is opted into explicitly by whoever
  // deploys this relay (index.js assembles the list for its own bundled
  // apps). A relay running only ToDo, or a future app nobody's written yet,
  // simply passes a different (or empty) `pushRules` array — no change to
  // this file ever required for a new app's own push behavior.
  //   pattern            — a `runtime.on()` pattern (core/pattern.js rules
  //                        apply: `*`/`**` only ever match a WHOLE segment).
  //   resolveRecipients  — `(q, runtime) => Promise<string[]> | string[]`,
  //                        the fingerprints to consider (still filtered
  //                        below against sender/online/no-subscription,
  //                        identically for every rule).
  //   buildPayload       — `(q, senderAlias) => Promise<{title, body}> |
  //                        {title, body}` — a rule's own responsibility to
  //                        stay generic (a template + the sender's alias,
  //                        NEVER the qubit's own decrypted content — this
  //                        file has no way to enforce that, it trusts each
  //                        rule the same way it already trusts `ingestGate`
  //                        entries).
  pushRules = [],
  // Fingerprints allowed to administer THIS relay — currently just
  // "write the runtime-maintained service catalog" (relay-services/<id>,
  // see below), server/service-registry.mjs's `attachStore()`. Empty by
  // default: an operator who never sets this simply gets no dynamic
  // service management, not an open-write hole (nobody can ever satisfy
  // `writers: []`, same "empty means nobody" convention core ACL already
  // uses elsewhere). A signed+encrypted admin-EVENT protocol for more
  // sensitive actions (toggling a code-level service, tuning a fail2ban
  // plugin) is a separate, later mechanism — this option only governs
  // ordinary signed writes to the plain-data service catalog, which
  // carries no secret content and so needs no encryption, only write-ACL.
  relayAdmins = [],
  // Optional server/service-registry.mjs instance — if given, its
  // routes()/ingestGates() are NOT automatically wired in here (an HTTP
  // route composition is server/*.mjs's job, not this file's — see
  // index.js), only its dynamic (store-backed) half is: attachStore()
  // below makes `relay-services/<id>` writes show up in the registry
  // live, and the ACL branch just below is what makes those writes
  // require a relayAdmins fingerprint in the first place.
  serviceRegistry = null,
  // Optional server/platform-registry.mjs instance — unlike
  // serviceRegistry above, this carries no routes/ingestGates at all (a
  // platform FEATURE isn't relay-executed code, see that file's own doc),
  // so there's nothing to wire into the HTTP/ingest pipeline here — only
  // the admin/config/platform-modules dispatch below touches it at all.
  platformRegistry = null,
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
  //
  // `relay-services/<id>` (server/service-registry.mjs's attachStore()):
  // readable by anyone (the portal's catalog is public), writable only by
  // a relayAdmins fingerprint — deliberately NOT mounted on a NullAdapter
  // like push-subscription/signal above, because this data SHOULD persist
  // across a restart (it's the actual runtime-maintained service catalog,
  // not ephemeral control-plane traffic) and stay ordinary, replicable
  // Space content — the same real `store` mount as everything else.
  //
  // `admin/<...>` — the signed+ENCRYPTED admin-command channel (see the
  // listener below): writable and readable only by a relayAdmins
  // fingerprint (unlike relay-services/ above, this is NOT meant to be
  // visible to arbitrary connected clients even in encrypted-envelope
  // form — restricting `readers` keeps it out of sync responses/pushes to
  // anyone but another admin). Mounted on a NullAdapter with
  // `replicate:false` by whoever builds `store` (index.js, same
  // convention as push-subscription/signal) — a command is an ephemeral
  // instruction, not state to persist or forward to other peers.
  const spacesACL = createSpaceACLResolver(relay.runtime);
  relay.setACLResolver(async (id) => {
    const m = /^push-subscription\/([0-9a-f]{24})$/i.exec(id);
    if (m) return { writers: [m[1]], readers: ['*'] };
    if (id.startsWith('relay-services/')) return { writers: relayAdmins, readers: ['*'] };
    // `relay-config/<key>` — deployment-wide, non-secret configuration data
    // a shell reads (e.g. `relay-config/theme`, see src/ui/theme.js) — same
    // "public content, admin-only writes" shape as relay-services/ above,
    // NOT the ephemeral encrypted admin/ channel below: this is ordinary,
    // persisted, replicated Space content (a plain signed write, no
    // encryptFor needed — a theme color is not confidential), not a
    // live-only command that reconfigures an in-memory object.
    if (id.startsWith('relay-config/')) return { writers: relayAdmins, readers: ['*'] };
    if (id.startsWith('admin/')) return { writers: relayAdmins, readers: relayAdmins };
    return spacesACL(id);
  });

  if (serviceRegistry) serviceRegistry.attachStore(relay.runtime);

  // Admin-command dispatch. Reaching this listener at all already proves
  // (a) a valid signature from (b) a relayAdmins fingerprint — both
  // enforced by the ordinary verify+ACL pipeline every ingest() already
  // runs, same as any other write, nothing bespoke here. What's left is
  // just: decrypt (only the relay's own private key can, see `identity`
  // above and index.js's `relay.publishProfile()`) and dispatch on the id
  // shape. `decryptWith()` returning `undefined` (envelope not actually
  // addressed to this identity — malformed, or encrypted for a DIFFERENT
  // relay's key by mistake) is treated as "ignore", not an error: an
  // admin channel that could be crashed by a malformed command would be
  // a worse failure mode than silently dropping one.
  //
  // Currently the only command shape: `admin/service/<id>` -> decrypted
  // `{ enabled, ttl? }` toggles a CODE-defined service's live `enabled`
  // flag (server/service-registry.mjs's setEnabled() — store-defined
  // services don't need this at all, see relay-services/ above, an
  // ordinary signed write already suffices for those). `ttl` (ms) makes
  // the toggle TEMPORARY: the relay schedules its own revert back to
  // whatever the flag was immediately before this command, unless a
  // newer command for the same id arrives first (in which case the
  // pending revert is cancelled — the newer command wins outright).
  const pendingReverts = new Map(); // serviceId -> { timer, revertTo }
  relay.runtime.on('admin/**', async (q) => {
    let decrypted;
    try {
      decrypted = await decryptWith(relay.identity, q.value);
    } catch (e) {
      debug('relay', 'admin-command-decrypt-failed', { id: q.id, writer: q.writer, error: e.message });
      return;
    }
    if (decrypted === undefined) {
      debug('relay', 'admin-command-not-for-us', { id: q.id, writer: q.writer });
      return;
    }
    debug('relay', 'admin-command', { id: q.id, writer: q.writer, command: decrypted });

    // `admin/config/rate-limit` -> `{ maxPerWindow?, windowMs? }`, live on
    // the `rateLimiter` instance passed in above (network/rate-limiter.js's
    // configure()). A no-op (not an error) if this relay wasn't given a
    // rateLimiter at all — same "configuration of something already
    // installed, never new logic" boundary as admin/service/<id>/<action>.
    if (q.id === 'admin/config/rate-limit') {
      if (typeof rateLimiter?.configure === 'function') {
        rateLimiter.configure(decrypted);
        debug('relay', 'admin-config-rate-limit', { config: rateLimiter.getConfig?.() });
      }
      return;
    }

    // `admin/config/connection-limit` -> `{ maxConnections?, allowedFingerprints? }`,
    // live on the `connectionGate` instance passed in above
    // (network/connection-gate.js's configure()). Same no-op-if-absent
    // reasoning as rate-limit above.
    if (q.id === 'admin/config/connection-limit') {
      if (typeof connectionGate?.configure === 'function') {
        connectionGate.configure(decrypted);
        debug('relay', 'admin-config-connection-limit', { config: connectionGate.getConfig?.() });
      }
      return;
    }

    // `admin/config/platform-modules` -> `{ modules: { [id]: boolean } }`,
    // live on the `platformRegistry` instance passed in above
    // (server/platform-registry.mjs's configure()). Same no-op-if-absent
    // reasoning as rate-limit/connection-limit above — a deployment that
    // never opted into a platformRegistry simply has no platform-feature
    // toggles to administer.
    if (q.id === 'admin/config/platform-modules') {
      if (typeof platformRegistry?.configure === 'function') {
        platformRegistry.configure(decrypted);
        debug('relay', 'admin-config-platform-modules', { config: platformRegistry.getConfig?.() });
      }
      return;
    }

    if (!serviceRegistry) return;

    // `admin/service/<id>` (no further segment) -> the built-in enable/
    // disable toggle every code-defined service already supports.
    const toggle = /^admin\/service\/([^/]+)$/.exec(q.id);
    if (toggle) {
      const serviceId = toggle[1];
      const pending = pendingReverts.get(serviceId);
      if (pending) { clearTimeout(pending.timer); pendingReverts.delete(serviceId); }

      const revertTo = serviceRegistry.isEnabled(serviceId);
      serviceRegistry.setEnabled(serviceId, !!decrypted.enabled);
      if (decrypted.ttl > 0) {
        const timer = setTimeout(() => {
          pendingReverts.delete(serviceId);
          serviceRegistry.setEnabled(serviceId, revertTo);
          debug('relay', 'admin-command-ttl-reverted', { id: serviceId, revertedTo: revertTo });
        }, decrypted.ttl);
        timer.unref?.(); // Node-only; never keep the process alive just for a pending revert (same reasoning as core/heartbeat.js's own timer)
        pendingReverts.set(serviceId, { timer, revertTo });
      }
      return;
    }

    // `admin/service/<id>/<action>` -> a service-specific action, handled
    // entirely by that service's own onAdminEvent() (server/service-
    // registry.mjs's extension contract) — e.g. relay/services/fail2ban.mjs's
    // "unban". This relay knows nothing about what actions a given custom
    // service supports; it only routes the (action, decrypted-payload)
    // pair to whichever definition claims that id, same "configuration of
    // an already-installed service, never new logic" boundary the
    // extension contract documents.
    const action = /^admin\/service\/([^/]+)\/([^/]+)$/.exec(q.id);
    if (action) {
      const [, serviceId, actionName] = action;
      const def = serviceRegistry.get(serviceId);
      const handled = def?.onAdminEvent ? def.onAdminEvent(actionName, decrypted) : false;
      debug('relay', 'admin-service-action', { id: serviceId, action: actionName, handled: !!handled });
    }
  });

  // A registered custom service's own ingestGates (e.g. relay/services/
  // fail2ban.mjs's ban-check) run in the SAME per-connection pipeline as
  // requireDirectWriter/rateLimiter/the caller's own `ingestGate` array —
  // appended after them, same "a fourth protection is a function, not a
  // new constructor flag" reasoning ingest-gate.js's own doc already
  // establishes. registry.ingestGates() already wraps each one with a
  // live `enabled` check (server/service-registry.mjs), so a service
  // toggled off via an admin command stops enforcing immediately without
  // this pipeline ever being rebuilt.
  const hub = new ReplicationHub(relay.runtime, {
    identity: relay.identity, getACL: relay.acl, pushTopics, requireDirectWriter, rateLimiter,
    ingestGate: [...ingestGate, ...(serviceRegistry?.ingestGates() ?? [])],
    allowDynamicSubscribe, maxDynamicTopics,
  });

  // Lets a custom service OBSERVE real ingest rejections (e.g. fail2ban
  // counting failures toward a ban) without this relay needing a bespoke
  // "on ingest failure" hook — network/replication/default.js's existing
  // debug('replication', 'push-rejected', { writer, ... }) event already
  // carries everything needed; attachDebugBus() (if a service defines it)
  // is just that service subscribing to the same debug bus (core/debug.js)
  // any console-debug listener already uses.
  if (serviceRegistry) {
    for (const def of serviceRegistry.list()) def.attachDebugBus?.();
  }
  const connected = new Map(); // fingerprint -> { channel, fileTransfer }
  const recentCallPushes = new Map(); // to-fingerprint -> timestamp of the last call-invite push sent them
  const CALL_PUSH_COOLDOWN_MS = 20_000; // examples/chat/app.mjs's startCall() re-announces 'call-invite' every 6s while ringing — without this, one ring would trigger a push every 6s instead of once

  // Notify an OFFLINE recipient by Web Push instead of the live delivery
  // they'd otherwise get through their own connection — this is what lets
  // an app reach someone whose tab/app isn't even open. Entirely driven by
  // `pushRules` (see this function's own doc comment on that parameter) —
  // this file has no idea what a "message" or an "event" is, it only ever
  // runs whatever rules it was handed. No qubit CONTENT is ever put in a
  // push payload beyond what a rule's own `buildPayload()` returns (by
  // convention: a generic template + the sender's alias, never decrypted
  // content) — a push service is not a party any app's encryption trusts,
  // exactly like the relay itself.
  if (sendPush) {
    for (const rule of pushRules) {
      relay.runtime.on(rule.pattern, async (q) => {
        if (q.ephemeral || !q.writer) return;
        const recipients = await rule.resolveRecipients(q, relay.runtime);
        for (const fp of recipients) {
          if (fp === q.writer || fp === '*' || connected.has(fp)) continue;
          const subscription = pushSubscriptions.get(fp);
          if (!subscription) continue;
          try {
            const aliasQ = await relay.runtime.get(`~${q.writer}/alias`);
            const senderName = aliasQ?.value ?? null;
            const payload = await rule.buildPayload(q, senderName);
            await sendPush({ subscription, payload: { ...payload, fp: q.writer } });
            debug('relay', 'push-sent', { to: fp, pattern: rule.pattern });
          } catch (e) {
            // A 404/410 means the push service considers this subscription
            // gone (expired/revoked) — drop it so future writes don't keep
            // retrying a dead endpoint; any other failure (network blip,
            // 5xx) is left in place for the next write to retry.
            if (e.status === 404 || e.status === 410) pushSubscriptions.delete(fp);
            debug('relay', 'push-failed', { to: fp, pattern: rule.pattern, error: e.message, status: e.status });
            console.error(`[Relay] push to ${fp} failed:`, e.message);
          }
        }
      });
    }

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
  const pendingMirrors = new Map(); // fingerprint -> Map<qubit id, attempts so far>
  const MAX_PENDING_MIRRORS_PER_UPLOADER = 200; // bounded, same reasoning as maxDynamicTopics above — one uploader shouldn't be able to grow this forever
  // Ohne eine Obergrenze retried der Sweep unten (alle 20s) eine id für
  // immer — für eine ECHT vorübergehende Störung (Uploader kurz offline,
  // eine einzelne verlorene Antwort) ist das richtig, aber für einen
  // DAUERHAFTEN Fehlschlag (ACL nachträglich entzogen, Uploader hat die
  // Datei nie wirklich vollständig — requestFile() bricht dann jedes Mal
  // an derselben Stelle ab) bedeutet es, für immer alle 20s denselben
  // Sweep-Slot zu verbrauchen, ohne dass sich je etwas ändert. 10 Versuche
  // (~200s bei 20s-Takt) sind großzügig genug für jede realistische
  // vorübergehende Störung, aber nicht endlos.
  const MAX_MIRROR_ATTEMPTS = 10;
  // Welche ids GERADE laufen — ein großer Anhang kann länger brauchen, als
  // der periodische Sweep unten auseinander liegt (20s); ohne diese Sperre
  // würde der Sweep für eine noch laufende id einen zweiten, redundanten
  // requestFile()-Durchlauf parallel lostreten (dieselbe Absicherung wie
  // examples/chat/app.mjs's confirmInFlight, hier serverseitig).
  const mirrorInFlight = new Set();

  function queueMirrorRetry(writer, id) {
    let pending = pendingMirrors.get(writer);
    if (!pending) { pending = new Map(); pendingMirrors.set(writer, pending); }
    if (pending.has(id) || pending.size < MAX_PENDING_MIRRORS_PER_UPLOADER) pending.set(id, pending.get(id) ?? 0);
  }

  async function mirrorFile(id, writer, fileTransfer) {
    if (mirrorInFlight.has(id)) return;
    mirrorInFlight.add(id);
    debug('relay', 'mirror-start', { id, writer });
    try {
      // Höhere Concurrency als transfer.js's eigener Default (24 statt 12)
      // — der Relay zieht die Chunks vom UPLOADER (typischerweise ein
      // Handy mit begrenztem Upload, aber der Relay selbst hat auf seiner
      // Seite normalerweise deutlich mehr Spielraum), mehr gleichzeitig
      // ausstehende Requests nutzen die verfügbare Bandbreite des
      // Uploaders besser aus, solange dessen Roundtrip-Zeit (nicht
      // Bandbreite) der limitierende Faktor ist.
      await fileTransfer.requestFile(id, { concurrency: 24 });
      pendingMirrors.get(writer)?.delete(id);
      debug('relay', 'mirror-complete', { id });
    } catch (e) {
      const attempts = (pendingMirrors.get(writer)?.get(id) ?? 0) + 1;
      if (attempts >= MAX_MIRROR_ATTEMPTS) {
        pendingMirrors.get(writer)?.delete(id);
        debug('relay', 'mirror-abandoned', { id, attempts, error: e.message });
        console.error(`[Relay] giving up mirroring ${id} after ${attempts} attempts:`, e.message);
      } else {
        queueMirrorRetry(writer, id); // ensures the writer's Map exists and id is present
        pendingMirrors.get(writer).set(id, attempts); // then record the REAL attempt count — queueMirrorRetry() alone would leave an existing id's count untouched, which is correct for its OTHER caller (the ingest hook, where "already queued" must not reset progress) but wrong here, where a fresh failure must always advance the count
        debug('relay', 'mirror-failed', { id, attempts, error: e.message });
        console.error(`[Relay] failed to mirror ${id} (attempt ${attempts}/${MAX_MIRROR_ATTEMPTS}):`, e.message);
      }
    } finally {
      mirrorInFlight.delete(id);
    }
  }

  relay.runtime.on('*/files/**', (q) => {
    if (q.ephemeral || !q.writer) return;
    const uploader = connected.get(q.writer);
    if (!uploader) {
      debug('relay', 'mirror-skip-uploader-offline', { id: q.id, writer: q.writer });
      queueMirrorRetry(q.writer, q.id);
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
      for (const id of [...ids.keys()]) mirrorFile(id, fp, uploader.fileTransfer);
    }
  }, 20000);
  if (typeof mirrorRetryTimer.unref === 'function') mirrorRetryTimer.unref();

  /** Authenticates and attaches one Channel. Returns its proven peerFingerprint (or null if anonymous) and its per-connection DefaultFileTransfer. */
  async function attachChannel(channel) {
    const { peerFingerprint } = await hub.attach(channel);

    // Connection-limit check happens AFTER handshake (only then do we know
    // peerFingerprint) but BEFORE this connection is treated as live in any
    // other way — reject it here means it never enters `connected`, never
    // gets a DefaultFileTransfer, never wires the routed-signaling listener
    // below. hub.attach() has already run by this point (the handshake
    // itself always succeeds/fails on its own terms, independent of this
    // gate), so a rejected connection is closed right back down rather than
    // left half-wired.
    if (connectionGate) {
      const { allowed, reason } = connectionGate.check({ fingerprint: peerFingerprint, connectedCount: connected.size });
      if (!allowed) {
        debug('relay', 'connection-rejected', { channelId: channel.id, peerFingerprint, reason });
        await channel.close();
        return { peerFingerprint: null, fileTransfer: null };
      }
    }

    debug('relay', 'channel-attached', { channelId: channel.id, peerFingerprint });
    const fileTransfer = new DefaultFileTransfer(relay.runtime, channel, fileStorage);
    if (peerFingerprint) connected.set(peerFingerprint, { channel, fileTransfer });

    // Retry any of THIS fingerprint's uploads the proactive mirror above
    // couldn't finish earlier (they were offline, or the attempt failed
    // mid-transfer) — see pendingMirrors' doc comment. Iterated as a copy
    // (`[...pending.keys()]`) since mirrorFile() mutates the same Map it's
    // iterating (deletes on success).
    const pendingForThisUploader = peerFingerprint ? pendingMirrors.get(peerFingerprint) : null;
    if (pendingForThisUploader?.size) {
      debug('relay', 'mirror-retry-on-reconnect', { fingerprint: peerFingerprint, count: pendingForThisUploader.size });
      for (const id of [...pendingForThisUploader.keys()]) mirrorFile(id, peerFingerprint, fileTransfer);
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
    /** Current effective rate-limit/connection-limit/platform-modules config — `null` for anything not installed at all (see `rateLimiter`/`connectionGate`/`platformRegistry` options above). Read by e.g. server/relay-info-routes.mjs for the admin dashboard. */
    getAdminConfig() {
      return {
        rateLimit: rateLimiter?.getConfig?.() ?? null,
        connectionLimit: connectionGate?.getConfig?.() ?? null,
        platformModules: platformRegistry?.getConfig?.() ?? null,
      };
    },
  };
}
