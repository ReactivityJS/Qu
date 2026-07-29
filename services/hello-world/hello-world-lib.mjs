// Pure logic layer for services/hello-world — the App-Template's own
// minimal reference example (services/README.md points here). Node-
// testable (no DOM), same "logic separate from UI" split every service in
// this repo follows (see services/README.md's own `<name>-lib.mjs` +
// `<name>-lib.test.mjs` convention).
//
// Demonstrates the three data shapes a new app almost always needs:
//   1. A PER-USER setting (own greeting name) — plain leaf QuBit under
//      the caller's OWN Space, exactly the "each field its own LWW
//      register" shape this whole codebase uses everywhere (see e.g.
//      modules/profiles.js's custom attributes).
//   2. A PER-USER counter (own visit count) — deliberately NOT a single
//      mutable integer read-then-incremented-then-written: `qu.own.get()`
//      (like any plain `.get()`/`await node`) is local-store-only, no
//      network I/O (see src/network/index.js's own doc) — right after a
//      reload the local Space is genuinely empty (qu-app-shell.mjs mounts
//      apps before `qu.connect()` even resolves, let alone before the own
//      Space has re-synced from the relay), so a naive read-then-write
//      would read back `0`, increment to `1`, and overwrite whatever
//      higher count the relay already held — a real, deterministic
//      regression on every single reload, not a rare simultaneous-device
//      edge case. Modelled instead as one append-only, uniquely-keyed
//      QuBit PER VISIT (`modules/starred.js`'s exact "one writer per
//      subtree" primitive, reused verbatim — a visit is just something
//      this identity "marks", like a favorited app), counted on read —
//      never read-modify-write, so there is nothing to race with a
//      still-in-flight sync.
//   3. A single GLOBAL, admin-only-writable, publicly-readable setting
//      (`relay-config/hello-world-greeting`) — the EXACT mechanism
//      src/ui/theme.js's deployment-wide theme already uses
//      (relay/relay.mjs's own ACL: `relay-config/*` is `writers:
//      relayAdmins, readers: '*'`), reused verbatim rather than inventing
//      a second admin-write channel. No server changes needed for this —
//      any app can add its own `relay-config/<its-own-key>` setting the
//      same way.

import { star, listStarred, onStarredChange } from '../../src/modules/starred.js';

const OWN_GREETING_NAME_ID = 'apps/hello-world/greeting-name';
const VISITS_PREFIX = 'apps/hello-world/visits';
const GLOBAL_GREETING_ID = 'relay-config/hello-world-greeting';

/** Reads the caller's own chosen greeting name — `null` if never set. */
export async function getOwnGreetingName(qu) {
  const q = await qu.own.get(OWN_GREETING_NAME_ID);
  return q?.value ?? null;
}

/** Sets the caller's own greeting name — plain (not encrypted): a display name for a "hello world" demo has no reason to be confidential (see src/modules/profiles.js's custom attributes for the encrypted-private option, already demonstrated there). */
export async function setOwnGreetingName(qu, name) {
  return qu.own.get(OWN_GREETING_NAME_ID).put(name);
}

/** Live subscription to the caller's own greeting name — `initial: true` delivers the current value immediately (if ever set), then every future change (e.g. from another of this identity's own devices). */
export function onOwnGreetingNameChange(qu, callback, opts) {
  return qu.own.get(OWN_GREETING_NAME_ID).on(callback, { initial: true, ...opts });
}

/** Records one visit as its own new, uniquely-keyed QuBit — never reads existing state first, so it can never regress a count a not-yet-synced local Space doesn't know about yet (see this file's own top doc). */
export async function recordVisit(qu) {
  const itemId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await star(qu, VISITS_PREFIX, itemId);
  return itemId;
}

/** One-shot read of the caller's own visit count — counts currently-starred (non-tombstoned) visit markers, `0` if never visited. */
export async function getOwnVisitCount(qu) {
  return (await listStarred(qu, VISITS_PREFIX)).length;
}

/**
 * Live subscription to the caller's own visit COUNT (not the raw QuBits) —
 * `callback(count)` fires once with the current total (as soon as the
 * local+synced state is known, possibly in more than one step: an empty
 * local Space right after reload delivers `0` first, then corrects itself
 * upwards as `onStarredChange()`'s underlying catch-up sync arrives — same
 * "render optimistically, re-render once real state resolves" idiom
 * shell/qu-app-shell.mjs's own `_reRenderIdentityIfCurrent()` documents),
 * then again on every future visit (this device or another of the same
 * identity's own devices).
 */
export function onOwnVisitCountChange(qu, callback, opts) {
  const seen = new Map(); // itemId -> still-starred?
  const emit = () => callback([...seen.values()].filter(Boolean).length);
  return onStarredChange(qu, VISITS_PREFIX, (q) => {
    const itemId = q.id.slice(q.id.lastIndexOf('/') + 1);
    seen.set(itemId, q.value != null);
    emit();
  }, opts);
}

/** Reads the deployment-wide admin-set greeting — `null` if no admin has ever configured one (this app's own default copy then simply applies, see app.mjs). */
export async function getGlobalGreeting(qu) {
  const q = await qu.get(GLOBAL_GREETING_ID);
  return q?.value ?? null;
}

/**
 * Sets the deployment-wide greeting — succeeds locally regardless of
 * whether the caller is actually a QU_RELAY_ADMINS fingerprint (see
 * src/ui/theme.js's `setTheme()` for the identical reasoning: the
 * relay's OWN ACL is what actually enforces this once the write reaches
 * the network; a rejected write here never throws locally).
 */
export async function setGlobalGreeting(qu, message) {
  return qu.session.publish(GLOBAL_GREETING_ID, message);
}

/** Live subscription to the global greeting — same `initial: true` single-call idiom as `onOwnGreetingNameChange()` above. */
export function onGlobalGreetingChange(qu, callback, opts) {
  return qu.get(GLOBAL_GREETING_ID).on(callback, { initial: true, ...opts });
}
