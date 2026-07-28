// Which optional PLATFORM FEATURES (not services/apps — see
// service-registry.mjs for those) a QUniverse-style shell offers on top of
// its lean baseline (identity, routing, connectivity — always present, not
// individually toggleable): a contact list, a CMS-based personal homepage,
// cross-app notification aggregation, the public opt-in directory, and
// incognito identities. A deployment running only a single service (e.g.
// "just Messenger, no ecosystem feel") can turn every one of these off — the
// baseline shell then installs no plugin and imports no screen module for a
// disabled feature, paying for nothing beyond what that one service needs.
//
// Deliberately much simpler than service-registry.mjs: no `routes`/
// `ingestGates` at all, since a platform FEATURE isn't code the relay
// itself executes — it's a shell-side plugin-install/screen-import
// decision (src/modules/contacts.js's createContactsPlugin(), cms.js's
// createCmsPlugin(), etc. already exist independently; this registry only
// tracks whether a given deployment currently wants each one active). Pure
// config data: a fixed list of known ids + a live, admin-mutable `enabled`
// flag per id — administered through the exact same `admin/config/*`
// pattern relay.mjs's rate-limit/connection-limit already use (see there),
// not a new protocol.
//
// All five default to enabled — "a solid, well-known base" (the same
// `enabledByDefault ?? true` stance service-registry.mjs's own definitions
// take) that an operator narrows down for a leaner deployment, not an
// opt-in list that starts empty.
export const PLATFORM_MODULES = [
  { id: 'contacts', label: 'Kontaktliste' },
  { id: 'cms-homepage', label: 'CMS-Startseite' },
  { id: 'notifications', label: 'Benachrichtigungen' },
  { id: 'directory', label: 'Öffentliches Verzeichnis' },
  { id: 'incognito', label: 'Incognito-Identitäten' },
];

/**
 * `overrides`: `{ [id]: boolean }`, e.g. from an env var at startup
 * (mirrors index.js's `QU_SERVICES_DISABLED` convention for
 * service-registry.mjs) — any id not present keeps its default (enabled).
 */
export function createPlatformRegistry(overrides = {}) {
  const state = new Map(PLATFORM_MODULES.map((m) => [m.id, { ...m, enabled: overrides[m.id] ?? true }]));

  return {
    /** Every known module with its current live state — what an admin dashboard renders. */
    list() {
      return [...state.values()];
    },

    isEnabled(id) {
      return state.get(id)?.enabled ?? false;
    },

    /** No-op (not a throw) for an unknown id — same "a stale/mistyped id from a future admin event must not crash the relay" stance service-registry.mjs's setEnabled() takes. */
    setEnabled(id, enabled) {
      const mod = state.get(id);
      if (!mod) return false;
      mod.enabled = !!enabled;
      return true;
    },

    /**
     * Live-reconfigure several modules at once — an admin command's
     * `{ modules: { [id]: boolean } }` payload (see relay.mjs's
     * `admin/config/platform-modules` dispatch). Unknown ids are silently
     * ignored, same reasoning as setEnabled() above; `modules` itself being
     * absent/empty is a no-op, not an error.
     */
    configure({ modules } = {}) {
      if (!modules) return;
      for (const [id, enabled] of Object.entries(modules)) this.setEnabled(id, enabled);
    },

    /** `{ [id]: boolean }` — the shape `admin/config/platform-modules`'s payload itself uses, and what relay.mjs's getAdminConfig() exposes via /relay/info for a shell/admin dashboard to read the CURRENT state. */
    getConfig() {
      return Object.fromEntries(this.list().map((m) => [m.id, m.enabled]));
    },
  };
}
