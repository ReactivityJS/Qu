// Single source of truth for "what can this relay deployment optionally
// offer" — services (real, usable apps), examples (developer-facing demo
// code), documentation, and custom (deployment-specific extensions, e.g.
// admin reporting or a fail2ban-style ingest gate, see relay/services/).
//
// Replaces two independently hand-maintained catalogs that used to exist
// (server/portal-routes.mjs's `SERVICE_APPS` object and portal.mjs's own
// separate copy of it, explicitly documented there as "kept in sync
// manually") with one list every consumer — the HTTP route composition in
// index.js, the portal UI, a future admin UI — reads from instead of
// re-declaring.
//
// Enable/disable is a RUNTIME-mutable flag on an already-installed
// definition, never a re-registration of routes/gates — see routes()'s
// doc comment below for why: this is what lets an admin flip a service on/
// off live without touching anything structural (the route array itself,
// an ingest-gate pipeline already built into a connection) that would be
// unsafe/expensive to rebuild per-request.
//
// Two different kinds of "adding a service at runtime, no restart":
//   - A pure-data entry (name/path/an `entry` link, e.g. "here's a link to
//     a Forum instance hosted elsewhere") CAN be added/edited/removed at
//     runtime, with no restart — see attachStore() below: it's an ordinary
//     signed QuBit write, ACL-gated, no code involved.
//   - A CODE-backed entry (one with real `routes`/`ingestGates` functions)
//     cannot — that would mean loading executable code from the network
//     at runtime, a deliberate non-goal (see relay/services/ doc on the
//     custom-service extension point). Those are only ever declared in
//     `definitions` at construction time; only their `enabled` flag is
//     runtime-mutable (setEnabled()).

/**
 * `definitions`: array of
 *   {
 *     id: string,                                   // stable key
 *     category: 'service' | 'example' | 'documentation' | 'custom',
 *     label: string,
 *     description?: string,
 *     entry?: string,             // simple redirect target, e.g. '/examples/chat/index.html'
 *     routes?: [{ match(pathname), handle(req,res) }], // optional — exact server/static-server.mjs shape
 *     ingestGates?: [(ctx, next) => Promise<void>],     // optional — exact src/network/ingest-gate.js shape
 *     onAdminEvent?: (action, payload) => any,          // optional — see relay/relay.mjs's admin/service/<id>/<action> dispatch
 *     enabledByDefault?: boolean, // default true
 *
 *     // QUniverse App Manifest fields — all optional, purely descriptive
 *     // metadata read by an ecosystem shell (nav dropdown, router, ACL
 *     // defaults). None of these are enforced by THIS file — enforcement,
 *     // where it exists at all, stays where it already lives (a Space's
 *     // own manifest for writers/readers, core/acl.js for the actual
 *     // check). Adding one of these to an existing definition is
 *     // non-breaking: an app/consumer that doesn't know about a field
 *     // simply never reads it.
 *     icon?: string,              // nav dropdown rendering, e.g. an emoji or icon-font class
 *     navOrder?: number,          // sort hint for a nav dropdown/catalog listing
 *     spaceMode?: 'fixed' | 'perUser' | 'perInstance', // which App-Space pattern this app uses (APP-GUIDE.md Schritt 3) — 'fixed': one well-known App-Space id for the whole app; 'perUser': one space per user (e.g. a personal ToDo list); 'perInstance': many independently-created spaces (e.g. forum boards), see examples/space-index-lib.mjs
 *     fixedSpaceId?: string,      // only meaningful when spaceMode === 'fixed' — the app's hardcoded App-Space id (a UUID, not a readable name, see APP-GUIDE.md's warning on shared infrastructure)
 *     requiredPlugins?: string[], // qu.use() plugin names this app needs beyond an ecosystem shell's own Runtime-level defaults — usually empty, since Spaces/Membership/Profiles/Network are typically already installed once by the shell
 *     aclDefaults?: { readers?: string[], encryptByDefault?: boolean }, // documented default manifest choice for a NEW space this app creates — informational only, an app still calls createSpace()/createSpaceAt() itself
 *     notificationTopics?: string[], // which inbox-<fp>/notifications/<kind> subtrees (src/modules/notifications.js) this app writes to, for a welcome-page feed to label them
 *     mount?: string,             // an embeddable module entry point, for a shell that mounts an app in-place instead of redirecting to `entry` — additive, `entry` remains the primary/default mechanism
 *     usesCms?: boolean,          // opts into src/modules/cms.js for user-authored templates/content
 *   }
 *
 * THE CUSTOM-SERVICE EXTENSION CONTRACT (category: 'custom'): a third
 * party (not this repo) extends a relay deployment by writing a
 * `createXService(opts) -> definition` factory (same naming convention as
 * `createXPlugin()`/`createXRoutes()` elsewhere) and passing its result
 * into this function's `definitions` array — see relay/services/fail2ban.mjs
 * for a worked reference implementation (ingestGates + onAdminEvent both
 * used together).
 *
 * Deliberately CODE-LEVEL / DEPLOY-TIME ONLY — a NEW custom service still
 * needs a restart to install (same as any other option added to
 * createRelay()/index.js). This is NOT an oversight to "fix" by adding
 * remote/dynamic registration later: a custom service's `ingestGates` can
 * accept or reject arbitrary pushes for the WHOLE relay (the same trust
 * level as `requireDirectWriterGate`/`rateLimitGate`), so loading one from
 * a wire message would mean executing code an admin merely CLAIMED
 * ownership of, not code this deployment's own operator chose and
 * reviewed — a fundamentally different, and unacceptable, trust boundary
 * for this codebase's "no dynamic code loading" model. What genuinely CAN
 * be administered remotely, no restart, is an ALREADY-INSTALLED custom
 * service's ENABLED flag (setEnabled(), same as any other code-defined
 * service) and its own admin-event actions (onAdminEvent(), e.g.
 * fail2ban's "unban" — configuration, never new logic).
 */
export function createServiceRegistry(definitions = []) {
  const services = new Map(); // code-defined — declared in index.js, can carry routes/ingestGates (real code, only ever added at startup, see file doc above)
  const dynamic = new Map();  // store-defined — pure data (id/category/label/description/entry/enabled), added/edited/removed at RUNTIME via ordinary signed writes, see attachStore() below
  let detachStore = null;

  for (const def of definitions) {
    if (!def.id) throw new Error('[ServiceRegistry] a service definition is missing "id"');
    services.set(def.id, { enabledByDefault: true, ...def, enabled: def.enabledByDefault ?? true });
  }

  function all() {
    // Code-defined wins on id collision — a store-defined entry can never
    // shadow/override a real, code-backed service (one with actual
    // routes/ingestGates); at most it can add a NEW, purely link-based one.
    const merged = new Map(dynamic);
    for (const [id, def] of services) merged.set(id, def);
    return [...merged.values()];
  }

  return {
    list() {
      return all();
    },

    get(id) {
      return services.get(id) ?? dynamic.get(id) ?? null;
    },

    isEnabled(id) {
      return (services.get(id) ?? dynamic.get(id))?.enabled ?? false;
    },

    /** Flips a CODE-defined definition's live enabled state — never touches its routes/ingestGates arrays themselves, see file doc above. No-op (not a throw) for an unknown id: a stale/mistyped id from a future admin event must not be able to crash the relay. Store-defined entries are edited by publishing a new QuBit (see attachStore()), not through this method. */
    setEnabled(id, enabled) {
      const def = services.get(id);
      if (!def) return false;
      def.enabled = !!enabled;
      return true;
    },

    /**
     * Live-syncs pure-data service entries FROM the QuStore itself — the
     * concrete answer to "can a route also be runtime-maintained, from
     * inside the QuStore": yes, for entries that are just data (name,
     * path, an `entry` link target), because publishing/editing/removing
     * one is an ORDINARY signed write, gated by whatever ACL the caller's
     * `store`/`getACL` already enforces for `${prefix}*` (relay.mjs
     * restricts this to `relayAdmins`, see there) — no new protocol, no
     * dynamic code loading (a store-defined entry can only ever carry
     * `entry`, never `routes`/`ingestGates` — those need real functions,
     * which data on the wire cannot safely provide, see relay/services/
     * doc on the custom-service extension point for the full reasoning).
     *
     * `runtime.on(pattern, ..., {initial:true})` (core/runtime.js) both
     * delivers everything already stored AND keeps this live from then
     * on — no separate "load once, then subscribe" step needed. A tombstoned
     * entry (`{ ...fields, deleted: true }`, the same soft-delete
     * convention already used elsewhere in this codebase, e.g.
     * examples/todo-lib.mjs) is removed from `dynamic` rather than kept
     * around as a dead/hidden entry.
     */
    attachStore(runtime, { prefix = 'relay-services/' } = {}) {
      detachStore?.();
      detachStore = runtime.on(`${prefix}*`, (q) => {
        const id = q.id.slice(prefix.length);
        if (!q.value || q.value.deleted) { dynamic.delete(id); return; }
        dynamic.set(id, { id, category: 'service', enabledByDefault: true, ...q.value, enabled: q.value.enabled ?? true });
      }, { initial: true });
      return () => { detachStore?.(); detachStore = null; };
    },

    /**
     * Every service's own `routes` (if any), each wrapped so `match()`
     * additionally checks the service's CURRENT `enabled` flag — a plain
     * property read, the same cost `static-server.mjs`'s `routes.find()`
     * already pays per request today. This is the entire toggle
     * mechanism: nothing here rebuilds the array when a flag flips, the
     * wrapper just re-reads `def.enabled` fresh on every call.
     */
    routes() {
      const out = [];
      for (const def of all()) {
        for (const route of def.routes ?? []) {
          out.push({
            match: (p) => def.enabled && route.match(p),
            handle: route.handle,
          });
        }
      }
      return out;
    },

    /**
     * Every CODE-defined service's ingest gates (store-defined/dynamic
     * entries never carry ones, see file doc above), each wrapped with the
     * same live `enabled` check routes() uses — a disabled custom service
     * (e.g. relay/services/fail2ban.mjs toggled off via an admin command)
     * must stop enforcing immediately, without the gate pipeline itself
     * (built once per connection, see network/replication/default.js)
     * ever being rebuilt.
     */
    ingestGates() {
      const out = [];
      for (const def of services.values()) {
        for (const gate of def.ingestGates ?? []) {
          out.push(async (ctx, next) => (def.enabled ? gate(ctx, next) : next()));
        }
      }
      return out;
    },

    /** Metadata only (never route/gate functions) — what a portal UI or admin UI fetches to render the current catalog + state. A QUniverse App Manifest field (see file doc above) is included only when the definition actually carries it — an app that never set e.g. `icon` gets no `icon: undefined` key at all, keeping the shape identical to before these fields existed for every plain service definition. */
    toJSON() {
      const manifestFields = ['icon', 'navOrder', 'spaceMode', 'fixedSpaceId', 'requiredPlugins', 'aclDefaults', 'notificationTopics', 'mount', 'usesCms', 'hasSettings', 'hasAdmin'];
      return this.list().map((def) => {
        const { id, category, label, description, entry, enabled } = def;
        const out = { id, category, label, description, entry, enabled };
        for (const key of manifestFields) {
          if (def[key] !== undefined) out[key] = def[key];
        }
        return out;
      });
    },
  };
}
