// Whether DISABLED services should be visible to non-admin identities in a
// service catalog UI (e.g. QUniverse's services/app-directory) — a single
// deployment-wide boolean, same mechanism as this directory's own theme.js
// (`relay-config/theme`: plain, publicly readable, only an admin can write
// it — relay/relay.mjs's `relay-config/` ACL rule already covers ANY key
// under that prefix, so this needs zero relay.mjs changes). NOT the
// encrypted `admin/config/*` command channel — there is no live in-memory
// server state to reconfigure here, just an ordinary piece of Space content
// an admin publishes and everyone else reads. Entirely Node-safe (unlike
// theme.js's own `applyTheme()`) — no function here touches `document`.
//
// Lives in Qu-core (not under services/app-directory/) so both an
// examples/relay-admin panel (Qu-core demo) and a QUniverse service can
// import it without either depending on the other's own package — the
// service-registry.mjs `enabled` flag this pairs with is itself Qu-core,
// shared by every registered service regardless of which side of the
// Qu/QUniverse split it lives on.
//
// A caller's own UI decides what "admin always sees everything" means for
// itself (see services/app-directory/app.mjs) — this file only ever tracks
// the ONE shared flag, never an identity's role. Default `false` (disabled
// entries hidden) — the same "narrow by default" stance
// server/platform-registry.mjs's own modules take, inverted: here, showing
// MORE (including broken/off entries) is the opt-in, not the default.

const SHOW_DISABLED_SERVICES_ID = 'relay-config/show-disabled-apps';

/** One-shot read — `false` if never configured. */
export async function getShowDisabledServices(qu) {
  const q = await qu.get(SHOW_DISABLED_SERVICES_ID);
  return q?.value ?? false;
}

/**
 * Sets the deployment-wide flag — succeeds locally regardless of whether
 * the caller is actually a QU_RELAY_ADMINS fingerprint (same reasoning as
 * theme.js's `setTheme()`: the relay's own ACL is what actually enforces
 * this once the write reaches the network).
 */
export async function setShowDisabledServices(qu, value) {
  return qu.session.publish(SHOW_DISABLED_SERVICES_ID, !!value);
}

/** Live subscription — `initial: true` delivers the current value immediately, then every future change. */
export function onShowDisabledServicesChange(qu, callback, opts) {
  return qu.get(SHOW_DISABLED_SERVICES_ID).on(callback, { initial: true, ...opts });
}
